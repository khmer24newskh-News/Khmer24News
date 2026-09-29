/**
 * Unified source registry for the 8-section business intelligence report.
 *
 * Every source is fetched by the Worker itself. There is no local-PC component.
 *
 * That required replacing Google News, which answers Cloudflare with HTTP 503
 * regardless of headers or host (see DISCOVERY-NOTES.md for the measured
 * matrix). Bing News RSS answers the same egress with valid feed data, so the
 * "site:domain" queries became topical queries plus a keyword filter.
 */

export type Section =
  | "cambodia"
  | "asean"
  | "global"
  | "money"
  | "tech"
  | "competitor"
  | "customer"
  | "opportunity";

export const SECTION_META: Record<Section, { title: string; emoji: string }> = {
  cambodia: { title: "CAMBODIA", emoji: "\u{1F1F0}\u{1F1ED}" },
  asean: { title: "ASEAN", emoji: "\u{1F30F}" },
  global: { title: "GLOBAL", emoji: "\u{1F30E}" },
  money: { title: "MONEY & MARKETS", emoji: "\u{1F4B0}" },
  tech: { title: "AI & TECHNOLOGY", emoji: "\u{1F916}" },
  competitor: { title: "COMPETITORS", emoji: "\u{1F3E2}" },
  customer: { title: "CUSTOMER & DEMAND", emoji: "\u{1F465}" },
  opportunity: { title: "BUSINESS OPPORTUNITIES", emoji: "\u{1F680}" },
};

/** How the Worker obtains the articles for a source. */
export type Discovery = "rss" | "bing" | "listing";

export interface FeedSource {
  /** Stable key; also the value the ingest endpoint accepts. */
  id: string;
  label: string;
  section: Section;
  discovery: Discovery;
  /** rss/listing: the feed URL. bing: built by bingUrl(). */
  target: string;
  /**
   * Publisher domain. Empty for topical Bing sources, which deliberately draw
   * on many publishers rather than one.
   */
  domain: string;
  /**
   * bing: the topical query. Bing ignores `site:`, so relevance is enforced by
   * mustMention instead. Ignored for rss and listing.
   */
  query?: string;
  /**
   * bing: tried in order if `query` returns nothing.
   *
   * Bing's news index shifts, and a single query that quietly returns zero
   * articles is indistinguishable from a dead source. Two fallbacks turn that
   * silent failure into a visible one.
   */
  fallbackQueries?: string[];
  /** bing: keep the article only if it mentions one of these (case-insensitive). */
  mustMention?: string[];
  /** Classification fallback when no keyword matches. */
  defaultCategory: string | null;
  /** 1 = primary source, 2 = press/aggregator. */
  tier: number;
  /** Only keep articles that mention Cambodia. */
  requireCambodia?: boolean;
  note?: string;
}

/** Bing News RSS. Reachable from Cloudflare, unlike Google News. */
export function bingUrl(query: string): string {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`;
}

// ---------------------------------------------------------------------------
// 1. CAMBODIA - official topics, via Bing News
//
// Each entry replaces a Google `site:domain` query. Because Bing returns many
// publishers, `domain` is empty and mustMention keeps the topical filter that
// `site:` used to provide.
// ---------------------------------------------------------------------------
const CAMBODIA_BING: FeedSource[] = [
  { id: "AKP", label: "AKP / government", section: "cambodia", discovery: "bing", query: "Cambodia government", fallbackQueries: ["Cambodia cabinet", "Cambodia ministry"], mustMention: ["government", "cabinet", "ministry", "prime minister", "akp", "official"], target: "", domain: "", defaultCategory: null, tier: 2 },
  { id: "MEF", label: "Ministry of Economy & Finance", section: "cambodia", discovery: "bing", query: "Cambodia economy", fallbackQueries: ["Cambodia finance", "Cambodia budget"], mustMention: ["economy", "finance", "budget", "gdp", "fiscal", "growth", "inflation"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "NBC", label: "National Bank of Cambodia", section: "cambodia", discovery: "bing", query: "Cambodia central bank", fallbackQueries: ["Cambodia riel", "Cambodia interest rate"], mustMention: ["central bank", "riel", "bank of cambodia", "monetary", "interest rate", "khmer", "lending"], target: "", domain: "", defaultCategory: "Banking", tier: 1 },
  { id: "CIB / CDC", label: "Cambodian Investment Board", section: "cambodia", discovery: "bing", query: "Cambodia investment", fallbackQueries: ["Cambodia factory", "Cambodia project"], mustMention: ["investment", "investor", "project", "factory", "plant", "fdi", "concession", "development"], target: "", domain: "", defaultCategory: "Investment", tier: 1 },
  { id: "NIS", label: "Statistics & growth", section: "cambodia", discovery: "bing", query: "Cambodia economic growth", fallbackQueries: ["Cambodia inflation", "Cambodia gdp"], mustMention: ["growth", "gdp", "inflation", "statistics", "economy", "percent", "forecast"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "MLVT", label: "Labour & jobs", section: "cambodia", discovery: "bing", query: "Cambodia employment", fallbackQueries: ["Cambodia wage", "Cambodia workers"], mustMention: ["job", "labour", "labor", "worker", "employment", "wage", "salary", "skill", "training", "recruit"], target: "", domain: "", defaultCategory: "Jobs & Hiring", tier: 1 },
  { id: "Ministry of Commerce", label: "Trade & commerce", section: "cambodia", discovery: "bing", query: "Cambodia commerce", fallbackQueries: ["Cambodia trade", "Cambodia export"], mustMention: ["trade", "export", "import", "commerce", "tariff", "customs", "market"], target: "", domain: "", defaultCategory: "Marketplace", tier: 1 },
  { id: "Ministry of Tourism", label: "Tourism", section: "cambodia", discovery: "bing", query: "Cambodia tourism", fallbackQueries: ["Cambodia tourists", "Cambodia hotel"], mustMention: ["tourism", "tourist", "hotel", "angkor", "arrival", "travel", "visitors"], target: "", domain: "", defaultCategory: "Tourism", tier: 1 },
  { id: "Ministry of Land Management", label: "Land & property", section: "cambodia", discovery: "bing", query: "Cambodia land", fallbackQueries: ["Cambodia property", "Cambodia real estate"], mustMention: ["land", "property", "title", "real estate", "housing", "construction", "building"], target: "", domain: "", defaultCategory: "Property", tier: 1 },
  { id: "Customs & Excise", label: "Customs & tax", section: "cambodia", discovery: "bing", query: "Cambodia revenue", fallbackQueries: ["Cambodia tax", "Cambodia customs"], mustMention: ["customs", "tax", "excise", "duty", "revenue", "tariff"], target: "", domain: "", defaultCategory: "Government & Regulation", tier: 1 },
  { id: "IMF Cambodia", label: "IMF", section: "cambodia", discovery: "bing", query: "Cambodia IMF", mustMention: ["imf", "international monetary fund", "fund staff", "imf country"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1, requireCambodia: true },
  { id: "World Bank Cambodia", label: "World Bank", section: "cambodia", discovery: "bing", query: "Cambodia World Bank", mustMention: ["world bank", "world bank group", "ida", "worldbank"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1, requireCambodia: true },
  { id: "ADB Cambodia", label: "Asian Development Bank", section: "cambodia", discovery: "bing", query: "Cambodia Asian Development Bank", mustMention: ["asian development bank", "adb"], target: "", domain: "", defaultCategory: "Investment", tier: 1, requireCambodia: true },
  { id: "WTO Cambodia", label: "WTO", section: "cambodia", discovery: "bing", query: "Cambodia WTO trade organisation", mustMention: ["wto", "world trade organization", "world trade organisation"], target: "", domain: "", defaultCategory: "Marketplace", tier: 1, requireCambodia: true },
];

// ---------------------------------------------------------------------------
// 2. CAMBODIA - business press the Worker can fetch itself
//
// Phnom Penh Post was here and answers HTTP 403 to Cloudflare's egress on every
// path tried (/rss, /rss/news, /feed), so it was replaced with Khmer Daily, which
// serves a working feed. Phnom Penh Post news still reaches the brief through the
// Bing topics above, because Bing indexes it as a publisher.
// ---------------------------------------------------------------------------
const CAMBODIA_RSS: FeedSource[] = [
  { id: "KHMERDAILY", label: "Khmer Daily", section: "cambodia", discovery: "rss", target: "https://khmerdaily.com/feed/", domain: "khmerdaily.com", defaultCategory: "Cambodia Economy", tier: 2 },
];

// ---------------------------------------------------------------------------
// 3. ASEAN
// ---------------------------------------------------------------------------
const ASEAN: FeedSource[] = [
  { id: "ASEAN", label: "ASEAN Secretariat", section: "asean", discovery: "rss", target: "https://asean.org/feed", domain: "asean.org", defaultCategory: "Cambodia Economy", tier: 1, requireCambodia: false },
  // Regional economies via Google News, fetched locally. Most ASEAN central
  // banks have no working feed (403/404 when measured).
  { id: "ASEAN-TH", label: "Thailand economy", section: "asean", discovery: "bing", query: "Thailand economy", mustMention: ["thailand", "baht", "bangkok"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "ASEAN-VN", label: "Vietnam economy", section: "asean", discovery: "bing", query: "Vietnam economy trade", mustMention: ["vietnam", "vietnamese", "dong", "hanoi"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "ASEAN-ID", label: "Indonesia economy", section: "asean", discovery: "bing", query: "Indonesia economy rupiah", mustMention: ["indonesia", "indonesian", "rupiah", "jakarta"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "ASEAN-MY", label: "Malaysia economy", section: "asean", discovery: "bing", query: "Malaysia economy ringgit", mustMention: ["malaysia", "malaysian", "ringgit", "kuala lumpur"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "ASEAN-PH", label: "Philippines economy", section: "asean", discovery: "bing", query: "Philippines economy peso", mustMention: ["philippines", "philippine", "peso", "manila"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "ASEAN-SG", label: "Singapore economy", section: "asean", discovery: "bing", query: "Singapore economy MAS", mustMention: ["singapore", "singaporean", "mas", "sgd"], target: "", domain: "", defaultCategory: "Cambodia Economy", tier: 1 },
];

// ---------------------------------------------------------------------------
// 4. GLOBAL
// ---------------------------------------------------------------------------
const GLOBAL: FeedSource[] = [
  { id: "FED", label: "US Federal Reserve", section: "global", discovery: "rss", target: "https://www.federalreserve.gov/feeds/press_all.xml", domain: "federalreserve.gov", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "FED-MONEY", label: "US Fed - monetary policy", section: "global", discovery: "rss", target: "https://www.federalreserve.gov/feeds/press_monetary.xml", domain: "federalreserve.gov", defaultCategory: "Banking", tier: 1 },
  { id: "ECB", label: "European Central Bank", section: "global", discovery: "rss", target: "https://www.ecb.europa.eu/rss/press.html", domain: "ecb.europa.eu", defaultCategory: "Cambodia Economy", tier: 1 },
  { id: "BOJ", label: "Bank of Japan", section: "global", discovery: "rss", target: "https://www.boj.or.jp/en/rss/whatsnew.xml", domain: "boj.or.jp", defaultCategory: "Cambodia Economy", tier: 1 },
];

// ---------------------------------------------------------------------------
// 5. AI & TECHNOLOGY
// ---------------------------------------------------------------------------
const TECH: FeedSource[] = [
  { id: "TECHCRUNCH", label: "TechCrunch", section: "tech", discovery: "rss", target: "https://techcrunch.com/feed/", domain: "techcrunch.com", defaultCategory: "Technology & AI", tier: 2 },
  { id: "VERGE", label: "The Verge", section: "tech", discovery: "rss", target: "https://www.theverge.com/rss/index.xml", domain: "theverge.com", defaultCategory: "Technology & AI", tier: 2 },
  { id: "ARS", label: "Ars Technica", section: "tech", discovery: "rss", target: "https://feeds.arstechnica.com/arstechnica/index", domain: "arstechnica.com", defaultCategory: "Technology & AI", tier: 2 },
  { id: "MITTR", label: "MIT Technology Review", section: "tech", discovery: "rss", target: "https://www.technologyreview.com/feed/", domain: "technologyreview.com", defaultCategory: "Technology & AI", tier: 2 },
  { id: "GOOGLEAI", label: "Google AI Blog", section: "tech", discovery: "rss", target: "https://blog.google/technology/ai/rss/", domain: "blog.google", defaultCategory: "Technology & AI", tier: 1 },
  { id: "OPENAI", label: "OpenAI", section: "tech", discovery: "rss", target: "https://openai.com/news/rss.xml", domain: "openai.com", defaultCategory: "Technology & AI", tier: 1 },
  { id: "HUGGINGFACE", label: "Hugging Face", section: "tech", discovery: "rss", target: "https://huggingface.co/blog/feed.xml", domain: "huggingface.co", defaultCategory: "Technology & AI", tier: 2 },
  { id: "VENTUREBEAT", label: "VentureBeat", section: "tech", discovery: "rss", target: "https://venturebeat.com/feed/", domain: "venturebeat.com", defaultCategory: "Technology & AI", tier: 2, note: "rate-limits aggressively (429); tolerated" },
];

// ---------------------------------------------------------------------------
// 6. COMPETITORS
// CamHR, JobNet, BongThom and Jobs.com.kh publish no RSS. The two that respond
// return HTML listing pages, which need scraping and are deliberately not
// treated as feeds. Registered so the section can report them honestly rather
// than silently showing nothing.
// ---------------------------------------------------------------------------
const COMPETITORS: FeedSource[] = [
  { id: "JOBNET", label: "JobNet (competitor)", section: "competitor", discovery: "listing", target: "https://www.jobnet.com.kh/feed", domain: "jobnet.com.kh", defaultCategory: "Jobs & Hiring", tier: 3, note: "no RSS; HTML only" },
  { id: "BONGTHOM", label: "BongThom (competitor)", section: "competitor", discovery: "listing", target: "https://bongthom.com/rss", domain: "bongthom.com", defaultCategory: "Jobs & Hiring", tier: 3, note: "no RSS; HTML only" },
  { id: "CAMHR", label: "CamHR (competitor)", section: "competitor", discovery: "listing", target: "https://www.camhr.com/rss", domain: "camhr.com", defaultCategory: "Jobs & Hiring", tier: 3, note: "feed URL 404" },
];

export const ALL_SOURCES: FeedSource[] = [
  ...CAMBODIA_BING, ...CAMBODIA_RSS, ...ASEAN, ...GLOBAL, ...TECH, ...COMPETITORS,
];

export const SOURCE_BY_ID: Record<string, FeedSource> = Object.fromEntries(
  ALL_SOURCES.map((s) => [s.id, s]),
);

/** Every source the Worker fetches itself. There are no push-only sources. */
export const CLOUD_SOURCES = ALL_SOURCES.filter(
  (s) => s.discovery === "rss" || s.discovery === "bing",
);
/** Kept for the settings UI and the parity test; empty by design now. */
export const PUSH_SOURCES: FeedSource[] = [];
export const LISTING_SOURCES = ALL_SOURCES.filter((s) => s.discovery === "listing");

/** The URL a cloud source is actually fetched from. */
export function sourceUrl(source: FeedSource): string {
  if (source.discovery === "bing") return bingUrl(queryFor(source, 0));
  return source.target;
}

/** Every Bing query for a source, primary first. */
export function queriesFor(source: FeedSource): string[] {
  if (source.discovery !== "bing") return [];
  return [source.query, ...(source.fallbackQueries ?? [])].filter((q): q is string => Boolean(q));
}

/** The nth query, falling back to the primary when out of range. */
export function queryFor(source: FeedSource, index: number): string {
  const list = queriesFor(source);
  return list[index] ?? list[0] ?? "";
}

/** Broad domains where a Google News hit may not actually be about Cambodia. */
export const BROAD = new Set(["imf.org", "worldbank.org", "adb.org", "wto.org"]);

export const CAMBODIA_MARKERS = ["cambodia", "cambodian", "phnom penh", "áž€áž˜áŸ’áž–áž»áž‡áž¶", "áž—áŸ’áž“áŸ†áž–áŸáž‰"];

