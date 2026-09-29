/**
 * Diagnostic: can the Worker reach Google News at all?
 *
 * The local PC can, the Worker cannot, and the previous note concluded the
 * block was unavoidable. That conclusion was based on a custom User-Agent only,
 * so this probes the strategies that were never actually tried: browser headers,
 * alternative Google hosts, and server-side relay services.
 *
 * Kept in the repo because the answer can change - a proxy that works today may
 * rot tomorrow, and re-running this is cheaper than re-deriving the architecture.
 */

export interface ProbeResult {
  strategy: string;
  url: string;
  status: number | null;
  ok: boolean;
  bytes: number;
  items: number;
  ms: number;
  note?: string;
}

/** Same shape feeds.ts uses, so the probe tests the real request. */
export function newsUrl(domain: string): string {
  const q = `site:${domain} Cambodia`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept: "application/rss+xml,application/xml,text/xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function probe(
  strategy: string,
  url: string,
  init: RequestInit,
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
    const body = await res.text();
    const items =
      (body.match(/<item[\s>]/gi) ?? []).length || (body.match(/<entry[\s>]/gi) ?? []).length;
    return {
      strategy,
      url: url.slice(0, 120),
      status: res.status,
      ok: res.ok && items > 0,
      bytes: body.length,
      items,
      ms: Date.now() - started,
      ...(items === 0 && res.ok ? { note: "200 but no feed items" } : {}),
    };
  } catch (err) {
    return {
      strategy,
      url: url.slice(0, 120),
      status: null,
      ok: false,
      bytes: 0,
      items: 0,
      ms: Date.now() - started,
      note: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The strategies worth trying, in the order most likely to work. */
export function strategiesFor(feedUrl: string): { strategy: string; url: string; init: RequestInit }[] {
  return [
    { strategy: "plain", url: feedUrl, init: {} },
    { strategy: "browser-headers", url: feedUrl, init: { headers: BROWSER_HEADERS } },
    {
      strategy: "google-host-alt",
      url: feedUrl.replace("https://news.google.com", "https://news.google.co.th"),
      init: { headers: BROWSER_HEADERS },
    },
    {
      strategy: "allorigins",
      url: `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`,
      init: {},
    },
    {
      strategy: "codetabs",
      url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(feedUrl)}`,
      init: {},
    },
    { strategy: "jina-reader", url: `https://r.jina.ai/${feedUrl}`, init: {} },
    {
      strategy: "thingproxy",
      url: `https://thingproxy.freeboard.io/fetch/${feedUrl}`,
      init: {},
    },
    {
      strategy: "whateverorigin",
      url: `https://www.whateverorigin.org/get?url=${encodeURIComponent(feedUrl)}`,
      init: {},
    },
  ];
}

/** Run every strategy against one feed and report what worked. */
export async function probeGoogle(domain = "nbc.gov.kh"): Promise<ProbeResult[]> {
  const feedUrl = newsUrl(domain);
  const results: ProbeResult[] = [];
  // Sequential on purpose: these are third-party services and a burst from
  // Cloudflare's egress is the fastest way to get rate-limited.
  for (const s of strategiesFor(feedUrl)) {
    results.push(await probe(s.strategy, s.url, s.init));
  }
  return results;
}

/** The first strategy that actually returned feed items, if any. */
export function winner(results: ProbeResult[]): ProbeResult | null {
  return results.find((r) => r.ok && r.items > 0) ?? null;
}

/**
 * Alternatives to Google News: other search engines that publish a feed, and
 * the publisher paths worth trying directly.
 *
 * The point of this matrix is that the Worker must fetch its own sources. A
 * relay that works only for some sources is still better than a local PC, but a
 * keyless search engine that returns whole feeds is better still.
 */
export function alternativesFor(domain: string): { strategy: string; url: string; init: RequestInit }[] {
  const q = encodeURIComponent(`site:${domain} Cambodia`);
  const site = encodeURIComponent(`${domain} Cambodia`);
  return [
    { strategy: "bing-news-rss", url: `https://www.bing.com/news/search?q=${q}&format=RSS`, init: { headers: BROWSER_HEADERS } },
    { strategy: "yahoo-search-rss", url: `https://news.search.yahoo.com/rss?p=${site}`, init: { headers: BROWSER_HEADERS } },
    { strategy: "yahoo-headline-rss", url: `https://news.yahoo.com/rss/search?q=${site}`, init: { headers: BROWSER_HEADERS } },
    { strategy: "duckduckgo-html", url: `https://html.duckduckgo.com/html/?q=${site}`, init: { headers: BROWSER_HEADERS } },
    {
      strategy: "gdelt-json",
      url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=25&format=json&sort=datedesc`,
      init: {},
    },
    { strategy: "mojeek-rss", url: `https://www.mojeek.com/search?q=${site}&fmt=rss`, init: { headers: BROWSER_HEADERS } },
    { strategy: "startpage-rss", url: `https://www.startpage.com/sp/search?query=${site}&format=rss`, init: { headers: BROWSER_HEADERS } },
    { strategy: "seznam-rss", url: `https://search.seznam.cz/?q=${site}&format=rss`, init: { headers: BROWSER_HEADERS } },
  ];
}

/** Run the alternative matrix. */
export async function probeAlternatives(domain: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const s of alternativesFor(domain)) {
    const r = await probe(s.strategy, s.url, s.init);
    // GDELT answers JSON, not a feed; count records so it is not dismissed.
    if (r.bytes > 0 && r.items === 0 && /\[[\s\S]{80,}\]/.test(await safeBody(s.url, s.init))) {
      r.items = -1;
      r.note = "json array, not a feed";
    }
    results.push(r);
  }
  return results;
}

/**
 * Try candidate Bing queries for a source and report which ones return articles.
 *
 * Bing's news index is uneven: a long specific query often returns nothing where
 * a short one returns plenty. Guessing queries produces silent empty sources, so
 * the candidates are measured instead.
 */
export async function tuneQueries(
  candidates: string[],
  mustMention: string[] = [],
): Promise<{ query: string; items: number; sample: string[] }[]> {
  const out: { query: string; items: number; sample: string[] }[] = [];
  for (const q of candidates) {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`;
    const r = await probe("tune", url, { headers: BROWSER_HEADERS });
    let kept = 0;
    const sample: string[] = [];
    if (r.items > 0) {
      const body = await safeBody(url, { headers: BROWSER_HEADERS });
      for (const block of body.match(/<item[\s\S]*?<\/item>/gi) ?? []) {
        const m = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = (m?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        if (!title || title.length < 8) continue;
        if (mustMention.length && !mustMention.some((n) => title.toLowerCase().includes(n.toLowerCase()))) continue;
        kept++;
        if (sample.length < 3) sample.push(title.slice(0, 80));
      }
    }
    out.push({ query: q, items: kept, sample });
  }
  return out;
}

/** Probe candidate feed URLs for a source, to replace a dead or blocked feed. */
export async function tuneFeeds(
  candidates: { id: string; url: string }[],
): Promise<{ id: string; url: string; status: number | null; items: number }[]> {
  const out: { id: string; url: string; status: number | null; items: number }[] = [];
  for (const c of candidates) {
    const r = await probe(c.id, c.url, { headers: BROWSER_HEADERS });
    out.push({ id: c.id, url: c.url, status: r.status, items: r.items });
  }
  return out;
}

async function safeBody(url: string, init: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
