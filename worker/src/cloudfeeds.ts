/**
 * Direct RSS/Atom fetching, for every source the Worker reaches itself.
 *
 * Two transports: publisher feeds (rss) and Bing News RSS (bing). Google News
 * is deliberately absent - it answers Cloudflare with HTTP 503.
 */
import { REQUEST_TIMEOUT_MS } from "./config.ts";
import { isJunkTitle, stripSourceSuffix } from "./classify.ts";
import { CLOUD_SOURCES, bingUrl, queriesFor, type FeedSource } from "./registry.ts";

export interface FetchedArticle {
  sourceId: string;
  title: string;
  url: string;
  published: string | null;
  ageHours: number | null;
  summary: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

export function xmlUnescape(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export const stripTags = (html: string): string =>
  xmlUnescape(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

function tagValue(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? xmlUnescape(m[1]!).trim() : null;
}

function atomLink(block: string): string | null {
  const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return m ? m[1]! : null;
}

function parseDate(raw: string | null): { iso: string; ageHours: number } | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return {
    iso: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ageHours: Math.max(0, (Date.now() - ms) / 3_600_000),
  };
}

/** Parse an RSS 2.0 or Atom document. */
export function parseFeed(xml: string, limit = 25): FetchedArticle[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const out: FetchedArticle[] = [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const rawTitle = tagValue(block, "title");
    if (!rawTitle) continue;
    const url =
      tagValue(block, "link") ?? atomLink(block) ?? tagValue(block, "guid") ?? "";
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const date =
      parseDate(tagValue(block, "pubDate") ?? tagValue(block, "published") ?? tagValue(block, "updated"));
    out.push({
      sourceId: "",
      title: stripTags(rawTitle),
      url,
      published: date?.iso ?? null,
      ageHours: date ? Math.round(date.ageHours * 10) / 10 : null,
      summary: stripTags(tagValue(block, "description") ?? tagValue(block, "summary") ?? "").slice(0, 800),
    });
  }
  return out;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      // Bing serves a challenge page to obvious bots, so present a browser.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bing wraps every result in an apiclick redirect that carries the real URL in
 * a query parameter.
 *
 * Unwrapping matters: the raw link is 200+ characters of tracking noise, it eats
 * the Telegram length budget, and it is a Microsoft property rather than the
 * publisher the headline names. Unwrap anything that is not already a direct
 * article link.
 */
export function unwrapBingUrl(raw: string): string {
  if (!/bing\.com\/(news\/)?apiclick\.aspx/i.test(raw)) return raw;
  try {
    const inner = new URL(raw).searchParams.get("url");
    if (inner && /^https?:\/\//i.test(inner)) return inner;
  } catch { /* not parseable, so keep what we were given */ }
  return raw;
}

export interface CloudFetchResult {
  articles: FetchedArticle[];
  ok: number;
  failed: { sourceId: string; reason: string }[];
  /** Per-source counts, so a silently empty source is visible. */
  counts: Record<string, number>;
  /** Which query answered for each bing source, for diagnosing index drift. */
  used: Record<string, string>;
  ms: number;
}

/**
 * Fetch every cloud source in parallel. One flaky feed must not fail the run,
 * and a 429 is tolerated once because some publishers rate-limit.
 */
export async function fetchAllCloudSources(
  options: { lookbackHours?: number; maxPerSource?: number; retry429?: boolean } = {},
): Promise<CloudFetchResult> {
  const lookback = options.lookbackHours ?? 72;
  const maxPer = options.maxPerSource ?? 12;
  const started = Date.now();
  const failed: { sourceId: string; reason: string }[] = [];
  const counts: Record<string, number> = {};
  const used: Record<string, string> = {};

  const results = await Promise.all(
    CLOUD_SOURCES.map(async (source: FeedSource) => {
      // A bing source may have several queries; stop at the first that answers,
      // so a query going dry degrades instead of emptying the section.
      const urls =
        source.discovery === "bing"
          ? queriesFor(source).map((q) => ({ url: bingUrl(q), query: q }))
          : [{ url: source.target, query: "" }];

      let lastReason = "unknown";
      for (let attempt = 0; attempt < (options.retry429 ? 2 : 1); attempt++) {
        for (const candidate of urls) {
          try {
            const res = await fetchWithTimeout(candidate.url);
            if (res.status === 429 && attempt === 0) {
              lastReason = "429 rate limited";
              continue; // retry this same query once
            }
            if (!res.ok) {
              lastReason = `HTTP ${res.status}`;
              continue; // try the next query before giving up
            }
            const xml = await res.text();
            const parsed = parseFeed(xml, maxPer);
            if (parsed.length > 0) {
              return { source, articles: parsed, ok: true, reason: "", query: candidate.query };
            }
            lastReason = "no items";
          } catch (err) {
            lastReason = `${(err as Error).name}`;
          }
        }
      }
      return { source, articles: [] as FetchedArticle[], ok: false, reason: lastReason, query: "" };
    }),
  );

  const articles: FetchedArticle[] = [];
  let ok = 0;
  for (const r of results) {
    let kept = 0;
    if (r.ok) ok++;
    else failed.push({ sourceId: r.source.id, reason: r.reason });
    if (r.query) used[r.source.id] = r.query;
    for (const a of r.articles) {
      const title = stripSourceSuffix(a.title, r.source.label, "");
      if (isJunkTitle(title)) continue;
      // Bing returns many publishers for one topic, so the `site:` filter that
      // Google used to do has to be reapplied as a keyword filter.
      if (r.source.mustMention && !mentionsAny(title, r.source.mustMention)) continue;
      if (r.source.requireCambodia && !mentionsCambodiaText(title)) continue;
      articles.push({ ...a, sourceId: r.source.id, title, url: unwrapBingUrl(a.url) });
      kept++;
    }
    counts[r.source.id] = kept;
  }
  // Drop anything outside the lookback window so alerts stay current.
  const fresh = articles.filter(
    (a) => a.ageHours !== null && a.ageHours <= lookback,
  );
  return { articles: fresh, ok, failed, counts, used, ms: Date.now() - started };
}

function mentionsAny(text: string, needles: string[]): boolean {
  const low = text.toLowerCase();
  return needles.some((n) => low.includes(n.toLowerCase()));
}

function mentionsCambodiaText(text: string): boolean {
  const low = text.toLowerCase();
  return ["cambodia", "cambodian", "phnom penh", "កម្ពុជា", "ភ្នំពេញ"].some((m) => low.includes(m));
}
