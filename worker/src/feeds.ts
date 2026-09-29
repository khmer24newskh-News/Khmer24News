/**
 * Google News RSS discovery + real-article-URL resolution.
 *
 * Two things are load-bearing here:
 *  1. `entry.link` is an opaque news.google.com redirect and NEVER contains the
 *     publisher. The publisher only appears in `<source url="...">`. Filtering on
 *     the link rejects 100% of results.
 *  2. Google serves a JS page, not a 302, so `redirect: "follow"` does nothing.
 *     The real URL must be decoded via the same batchexecute RPC the web UI uses.
 */
import { BROAD_DOMAINS, REQUEST_TIMEOUT_MS, SOURCES, USER_AGENT, type Source } from "./config.ts";
import { isJunkTitle, mentionsCambodia, stripSourceSuffix } from "./classify.ts";

export interface FeedEntry {
  title: string;
  publisher: string;
  publisherUrl: string;
  link: string;
  published: string | null;
  ageHours: number | null;
  summary: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

export function xmlUnescape(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? xmlUnescape(m[1]!) : null;
};

const attr = (xml: string, name: string, attrName: string): string | null => {
  const m = xml.match(new RegExp(`<${name}[^>]*\\s${attrName}=["']([^"']*)["']`, "i"));
  return m ? xmlUnescape(m[1]!) : null;
};

/** Strip HTML tags to text. Replaces BeautifulSoup(...).get_text(" "). */
export function htmlToText(html: string): string {
  return xmlUnescape(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse an RFC 2822 pubDate, or null. */
export function parsePublished(raw: string | null): { iso: string; ageHours: number } | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const ageHours = Math.max(0, (Date.now() - ms) / 3_600_000);
  return { iso: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"), ageHours: Math.round(ageHours * 10) / 10 };
}

/** Parse a Google News RSS document into entries. No feedparser on Workers. */
export function parseRss(xml: string): FeedEntry[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const out: FeedEntry[] = [];
  for (const item of items) {
    const rawTitle = (tag(item, "title") ?? "").trim();
    const link = (tag(item, "link") ?? "").trim();
    if (!rawTitle || !link) continue;
    const publisherUrl = attr(item, "source", "url") ?? "";
    const publisher = (tag(item, "source") ?? "").trim();
    const parsed = parsePublished(tag(item, "pubDate"));
    out.push({
      title: rawTitle,
      publisher,
      publisherUrl,
      link,
      published: parsed?.iso ?? null,
      ageHours: parsed?.ageHours ?? null,
      summary: htmlToText(tag(item, "description") ?? ""),
    });
  }
  return out;
}

/** Does this entry really come from the configured domain? */
export function sourceHostOk(source: Source, entry: FeedEntry): boolean {
  if (entry.publisherUrl) {
    let host = "";
    try {
      host = new URL(entry.publisherUrl).hostname.toLowerCase();
    } catch {
      return false;
    }
    const expected = source.domain.toLowerCase();
    return host === expected || host.endsWith("." + expected) || expected.endsWith("." + host);
  }
  // Fallback for feeds that omit <source>: trust the publisher name in the title.
  return entry.title.toLowerCase().includes(source.name.toLowerCase());
}

export interface FetchStats {
  newCount: number;
  duplicate: number;
  stale: number;
  junk: number;
  offdomain: number;
  offTopic: number;
  undated: number;
  resolved: number;
  unresolved: number;
  errors: string[];
}

export function emptyStats(): FetchStats {
  return {
    newCount: 0, duplicate: 0, stale: 0, junk: 0, offdomain: 0,
    offTopic: 0, undated: 0, resolved: 0, unresolved: 0, errors: [],
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * Fetch one source's feed. Sources are fetched in PARALLEL by the caller -
 * Workers has a wall-clock limit, so sequential fetching with sleeps is not viable.
 */
export async function fetchSource(
  source: Source,
): Promise<{ entries: FeedEntry[]; error: string | null }> {
  const q = `site:${source.domain} Cambodia`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await withTimeout(
      fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      }),
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) return { entries: [], error: `${source.name}: HTTP ${res.status}` };
    const xml = await res.text();
    return { entries: parseRss(xml), error: null };
  } catch (err) {
    return { entries: [], error: `${source.name}: ${(err as Error).message}` };
  }
}

export interface Candidate {
  source: Source;
  entry: FeedEntry;
  title: string;
}

/**
 * Turn raw entries into storable candidates, applying every filter:
 * domain, freshness, junk titles, and Cambodia relevance for broad bodies.
 */
export function buildCandidates(
  source: Source,
  entries: FeedEntry[],
  lookbackHours: number,
  maxItems: number,
  stats: FetchStats,
): Candidate[] {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  const out: Candidate[] = [];
  for (const entry of entries.slice(0, maxItems)) {
    if (!sourceHostOk(source, entry)) {
      stats.offdomain++;
      continue;
    }
    if (entry.published === null || entry.ageHours === null) {
      stats.undated++;
      continue;
    }
    if (new Date(entry.published).getTime() < cutoff) {
      stats.stale++;
      continue;
    }
    const title = stripSourceSuffix(entry.title, source.name, entry.publisher);
    if (isJunkTitle(title)) {
      stats.junk++;
      continue;
    }
    if (BROAD_DOMAINS.has(source.domain) && !mentionsCambodia(`${title} ${entry.title}`)) {
      stats.offTopic++;
      continue;
    }
    out.push({ source, entry, title });
  }
  return out;
}

/** Decode one Google News article id to the publisher's real URL. */
export async function resolveRealUrl(link: string): Promise<string> {
  const m = link.match(/\/articles\/([^?&/]+)/);
  if (!m) return "";
  const articleId = m[1]!;
  try {
    // redirect: "follow" is required. Google answers this endpoint with a 302
    // back to a canonicalised copy of itself; with "manual" we get an empty
    // body and never see the data-n-a-* attributes the RPC needs.
    const pageRes = await withTimeout(
      fetch(`https://news.google.com/rss/articles/${articleId}`, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      }),
      REQUEST_TIMEOUT_MS,
    );
    if (!pageRes.ok) return "";
    const page = await pageRes.text();
    const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sig || !ts) return "";

    const rpc = [
      "Fbv4je",
      '["garturlreq",[["en-US","US",["FINANCE_TOP_INDICES","WEB_TEST_1_0_0"],null,null,' +
        `1,1,"US:en",null,180,null,null,null,null,null,0,1],"en-US","US",1,[2,3,4,8],` +
        `1,0,"655000234",0,0,null,0],"${articleId}",${ts},"${sig}"]`,
    ];
    const rpcRes = await withTimeout(
      fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": USER_AGENT,
        },
        body: "f.req=" + encodeURIComponent(JSON.stringify([[rpc]])),
      }),
      REQUEST_TIMEOUT_MS,
    );
    if (!rpcRes.ok) return "";
    const text = await rpcRes.text();
    for (const chunk of text.split("\n\n")) {
      if (!chunk.includes("garturlres")) continue;
      const rows = JSON.parse(chunk) as unknown[][];
      for (const row of rows) {
        if (Array.isArray(row) && row[0] === "wrb.fr" && typeof row[2] === "string") {
          const decoded = JSON.parse(row[2]) as unknown[];
          if (Array.isArray(decoded) && typeof decoded[1] === "string" && decoded[1]) {
            return decoded[1];
          }
        }
      }
    }
    return "";
  } catch {
    return "";
  }
}

/** Resolve a batch in parallel, respecting a hard cap. */
export async function resolveAll(
  links: string[],
  cap: number,
): Promise<{ resolved: Map<string, string>; resolvedCount: number }> {
  const resolved = new Map<string, string>();
  const batch = links.slice(0, cap);
  const results = await Promise.all(batch.map((l) => resolveRealUrl(l)));
  results.forEach((real, i) => {
    if (real) resolved.set(batch[i]!, real);
  });
  return { resolved, resolvedCount: resolved.size };
}

export { SOURCES };
