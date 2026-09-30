/**
 * Breaking-news alert cards.
 *
 * A streaming alert has one job: make the reader decide whether to stop and
 * read. A batched list of headlines does that badly. A single article presented
 * as a card - what happened, where it came from, why Cambodia should care - is
 * the difference between a glance and a stop.
 *
 * The card is only used for stories that genuinely clear the bar. Calling
 * everything breaking devalues the word, so severity is computed from the
 * article rather than assumed.
 */
import { GENERAL_CATEGORY, TELEGRAM_MAX_LEN } from "./config.ts";
import type { Article } from "./db.ts";

export type Severity = "HIGH" | "NORMAL";

/**
 * Shocks worth interrupting someone for.
 *
 * Deliberately specific. Loose words like "rate" or "policy" match almost every
 * article and would make the HIGH label meaningless.
 */
const SHOCK_TERMS: string[] = [
  // trade and geopolitics
  "tariff", "sanction", "trade war", "export control", "import ban", "quota",
  "war", "ceasefire", "border closure", "border closed",  // money
  "interest rate", "rate hike", "rate cut", "raises rates", "cuts rates",
  "devalue", "devaluation", "inflation", "default", "bailout", "recapitalis",
  "capital flight", "recession", "stimulus",
  // policy
  "royal decree", "sub-decree", "state council", "new law", "new tax",
  "state of emergency", "martial law", "coup", "import ban", "ban on",
  // disruption
  "crisis", "shock", "collapse", "crash", "plunge", "surge", "spike",
  "shortage", "blackout", "strike", "shutdown", "closure", "suspend",
  "flood", "drought", "outbreak", "epidemic",
];

/**
 * What counts as "about Cambodia".
 *
 * Place names are included because most Cambodian news never says "Cambodia" -
 * "Siem Reap hotel opens 120 rooms" is a domestic story that a keyword-only
 * check would file as foreign and therefore demote.
 */
const CAMBODIA_MARKERS = [
  "cambodia", "cambodian", "phnom penh", "កម្ពុជា", "ភ្នំពេញ",
  "siem reap", "battambang", "sihanoukville", "sihanoukville", "kratie",
  "kep province", "pailin", "tboung khmum", "preah vihear", "mondulkiri",
  "oddar meanchey", "stung treng", "ratanakiri", "battambang",
  "khmer", "riel", "angkor wat",
];

/** Categories that can move demand, cost or compliance for Khmer24. */
const IMPACT_CATEGORIES = new Set([
  "Banking", "Cambodia Economy", "Government & Regulation", "Investment",
  "Marketplace", "Property", "Jobs & Hiring", "Tourism", "Auto",
]);

/**
 * Categories that carry a foreign shock into Cambodia.
 *
 * A China-US tariff deal or a Fed rate move never mentions Cambodia, and it is
 * exactly the news that changes import cost and financing. Requiring the word
 * "Cambodia" would have classified the most commercially important stories of
 * the week as routine.
 */
const TRANSMITTING_CATEGORIES = new Set([
  "Cambodia Economy", "Banking", "Marketplace", "Government & Regulation",
]);

/** The word after the origin, per category. Read as "<origin> <type>". */
const CATEGORY_TYPE: Record<string, string> = {
  "Cambodia Economy": "macro data or policy",
  "Banking": "monetary policy or credit",
  "Government & Regulation": "regulation, tax or customs",
  "Investment": "investment or new project",
  "Marketplace": "trade, tariff or import cost",
  "Property": "property or construction",
  "Jobs & Hiring": "labour market or wages",
  "Tourism": "tourism or visitor demand",
  "Auto": "vehicle or auto market",
  "Technology & AI": "technology or AI",
};

/** What to actually review, per category. Imperative, because it is an order. */
const CAMBODIA_IMPACT: Record<string, string> = {
  "Cambodia Economy": "review pricing, promotions and demand forecasts",
  "Banking": "review financing exposure, lending cost and deposit demand",
  "Government & Regulation": "review compliance, tax and licensing for the affected categories",
  "Investment": "review Business, Property and Job demand created by the project",
  "Marketplace": "review import cost, pricing and seller margins",
  "Property": "review listing supply, agent demand and developer activity",
  "Jobs & Hiring": "review employer demand and recruitment packages",
  "Tourism": "review hospitality, retail and transport demand",
  "Auto": "review dealer inventory and vehicle-seller demand",
  "Technology & AI": "review job, hosting and equipment demand",
};

/** For a foreign shock, the transmission channel into Cambodia matters most. */
const EXTERNAL_IMPACT = "review business, import-cost, inflation and financing exposure";

const GENERAL_IMPACT = "review whether this affects pricing, cost or demand";

/** Which economy a story is mainly about. */
const ORIGINS: [string[], string][] = [
  [["china", "chinese", "beijing"], "China"],
  [["united states", "u.s.", "us", "america", "washington", "trump", "white house"], "US"],
  [["european union", "eurozone", "brussels", "ecb"], "EU"],
  [["germany", "german", "france", "french"], "EU"],
  [["japan", "japanese", "tokyo", "yen"], "Japan"],
  [["south korea", "korean", "seoul"], "South Korea"],
  [["india", "indian", "delhi", "rupee"], "India"],
  [["thailand", "thai", "bangkok", "baht"], "Thailand"],
  [["vietnam", "vietnamese", "hanoi", "dong"], "Vietnam"],
  [["indonesia", "indonesian", "jakarta", "rupiah"], "Indonesia"],
  [["malaysia", "malaysian", "kuala lumpur", "ringgit"], "Malaysia"],
  [["singapore", "singaporean", "sgd"], "Singapore"],
  [["philippines", "philippine", "manila", "peso"], "Philippines"],
  [["myanmar", "burmese", "naypyidaw"], "Myanmar"],
  [["imf", "international monetary fund"], "IMF"],
  [["world bank"], "World Bank"],
  [["asian development bank", "adb"], "ADB"],
  [["wto", "world trade organization", "world trade organisation"], "WTO"],
  [["cambodia", "cambodian", "phnom penh"], "Cambodia"],
];

/**
 * Which economies are close enough that a foreign shock matters here.
 *
 * Tier A are the large trading partners and the region. Tier B are ASEAN peers
 * whose own macro news rarely moves Cambodia - rupiah and ringgit stories were
 * interrupting on a par with a China-US tariff deal, which is not useful.
 */
const TIER_A_ORIGINS = new Set([
  "China", "US", "EU", "Japan", "South Korea", "India", "Thailand", "Vietnam",
]);
const TIER_B_ORIGINS = new Set([
  "Indonesia", "Malaysia", "Philippines", "Singapore", "Myanmar",
]);

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Word-boundary containment, tolerant of English inflection.
 *
 * Plain substring matching put "Autonom**us**" in the United States and
 * "eva**rate**d" in a rate story. Plain word boundaries fixed that but broke the
 * opposite way: "tariff" stopped matching "tariffs", and a tariff deal is
 * precisely the news that must not be missed.
 *
 * The boundary is therefore enforced on both sides, with the endings that turn a
 * noun into a real inflection - but only for needles long enough to survive it.
 * On a two-letter needle such as "us", tolerating "d" matched the "USD" in
 * "USD/IDR" and filed rupiah news as United States macro policy. Short needles
 * get exact matching, which is safer than being clever.
 */
const INFLECTED = "(?:s|es|ed|d|ing|al|ers?|ies)?";
const MIN_INFLECTABLE = 4;

function containsNeedle(haystack: string, needle: string): boolean {
  const n = needle.toLowerCase();
  // Khmer is not space-delimited, so there are no boundaries to respect.
  if (/[\u1780-\u17ff]/.test(n)) return haystack.includes(n);
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = n.length >= MIN_INFLECTABLE ? INFLECTED : "";
  return new RegExp(`(?<![a-z0-9])${escaped}${suffix}(?![a-z0-9])`).test(haystack);
}

function includesAny(text: string, needles: string[]): boolean {
  const low = text.toLowerCase();
  return needles.some((n) => containsNeedle(low, n));
}

/** Does this article mention Cambodia at all? */
export function mentionsCambodia(row: Article): boolean {
  return includesAny(`${row.title} ${row.summary ?? ""}`, CAMBODIA_MARKERS);
}

/** Words that indicate the story is a shock rather than routine news. */
export function isShock(text: string): boolean {
  return includesAny(text, SHOCK_TERMS);
}

/**
 * Which economy a story is mainly about.
 *
 * Cambodia wins over everything, including institutions. "IMF forecasts
 * Cambodia's growth at 3%" is a Cambodian story that happens to be sourced from
 * the IMF, and labelling it "IMF" sends the reader looking in the wrong place.
 *
 * Returns "Cambodia" when a Cambodian place name is present but no other country
 * is named, so a domestic story is never filed as "Regional".
 */
export function detectOrigin(text: string): string | null {
  if (includesAny(text, CAMBODIA_MARKERS)) return "Cambodia";
  return ORIGINS.find(([needles]) => includesAny(text, needles))?.[1] ?? null;
}

/**
 * Severity, and therefore whether the card is used at all.
 *
 * Two routes to HIGH:
 *   - it is about Cambodia, in a category that can move demand or cost, and it
 *     either describes a shock or scores highly;
 *   - it is a shock from a Tier A economy, in a category that transmits into
 *     Cambodia, such as trade, tariffs or monetary policy.
 *
 * Requiring the word "Cambodia" for the second route would have buried the most
 * commercially important news of the week, so a foreign shock is admitted on its
 * own merits - but only from an economy that actually trades with Cambodia.
 * A Tier B shock needs Cambodia mentioned too, or it stays quiet.
 */
export function severity(row: Article): Severity {
  if (row.category === GENERAL_CATEGORY) return "NORMAL";
  if (!IMPACT_CATEGORIES.has(row.category)) return "NORMAL";

  const text = `${row.title} ${row.summary ?? ""}`;
  const shock = isShock(text);
  const origin = detectOrigin(text);
  const mentionsCambodia = includesAny(text, CAMBODIA_MARKERS);

  if (origin === "Cambodia" || mentionsCambodia) {
    return shock || row.score >= 60 ? "HIGH" : "NORMAL";
  }
  if (!shock || !TRANSMITTING_CATEGORIES.has(row.category)) return "NORMAL";
  if (TIER_A_ORIGINS.has(origin ?? "")) return "HIGH";
  if (TIER_B_ORIGINS.has(origin ?? "")) return "NORMAL";
  // International bodies (IMF, World Bank, WTO) are treated as Tier A: they
  // report on Cambodia specifically when it matters.
  return origin !== null ? "HIGH" : "NORMAL";
}

export function isBreaking(row: Article): boolean {
  return severity(row) === "HIGH";
}

/** "<origin> <type>", with "shock" appended when the story is one. */
export function categoryLabel(row: Article): string {
  const text = `${row.title} ${row.summary ?? ""}`;
  const origin = detectOrigin(text) ?? "Regional";
  const type = CATEGORY_TYPE[row.category] ?? "business signal";
  const suffix = isShock(text) ? " shock" : "";
  return `${origin} ${type}${suffix}`;
}

/** The one action line, chosen by category and by where the shock originated. */
export function cambodiaImpact(row: Article): string {
  const text = `${row.title} ${row.summary ?? ""}`;
  const origin = detectOrigin(text);
  const foreign = origin !== "Cambodia" && !includesAny(text, CAMBODIA_MARKERS);
  if (foreign && TRANSMITTING_CATEGORIES.has(row.category)) {
    return EXTERNAL_IMPACT;
  }
  return CAMBODIA_IMPACT[row.category] ?? GENERAL_IMPACT;
}

const PUBLISHER_NAMES: Record<string, string> = {
  "phnompenhpost.com": "Phnom Penh Post",
  "khmertimes.com": "Khmer Times",
  "khmerdaily.com": "Khmer Daily",
  "cambodia-today.com": "Cambodia Today",
  "bloomberg.com": "Bloomberg",
  "reuters.com": "Reuters",
  "apnews.com": "AP News",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "ft.com": "Financial Times",
  "wsj.com": "Wall Street Journal",
  "nytimes.com": "New York Times",
  "theverge.com": "The Verge",
  "techcrunch.com": "TechCrunch",
  "arstechnica.com": "Ars Technica",
  "technologyreview.com": "MIT Technology Review",
  "openai.com": "OpenAI",
  "blog.google": "Google",
  "huggingface.co": "Hugging Face",
  "venturebeat.com": "VentureBeat",
  "federalreserve.gov": "US Federal Reserve",
  "ecb.europa.eu": "European Central Bank",
  "boj.or.jp": "Bank of Japan",
  "asean.org": "ASEAN",
  "imf.org": "IMF",
  "worldbank.org": "World Bank",
  "adb.org": "Asian Development Bank",
  "wto.org": "WTO",
  "vnexpress.net": "VnExpress",
  "vietnam.vnanet.vn": "Vietnam News",
  "v tv": "VTV",
  "tempo.co": "Tempo",
  "fibre2fashion.com": "Fibre2Fashion",
  "fxstreet.com": "FXStreet",
  "thethaiger.com": "The Thaiger",
  "bangkokpost.com": "Bangkok Post",
  "straitstimes.com": "Straits Times",
};

/**
 * The outlet that actually published it.
 *
 * The registry id is a topic ("CIB / CDC", "ASEAN-ID"), which is not what a
 * reader recognises. The URL host is the publisher, so that is what is shown.
 */
export function publisherName(row: Article): string {
  try {
    const host = new URL(row.url).hostname.toLowerCase().replace(/^(www|m|amp|news)\./, "");
    if (PUBLISHER_NAMES[host]) return PUBLISHER_NAMES[host]!;
    const sld = host.split(".")[0]!;
    return sld
      .split(/[-_]/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");
  } catch {
    return row.source;
  }
}

/** Trim the summary to something readable, and drop it if there is nothing. */
export function cardSummary(row: Article, limit = 420): string {
  const raw = clean(row.summary ?? "")
    // Feeds often repeat the headline and append the outlet; both are noise here.
    .replace(new RegExp(`^${row.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-–—]?\\s*`, "i"), "")
    .replace(/\s*[-–—]\s*[^-–—]{2,40}$/, "");
  if (raw.length < 24) return "";
  return raw.length > limit ? `${raw.slice(0, limit).trimEnd()}...` : raw;
}

/**
 * One article, one card.
 *
 * A card has its own headline, category, source link and preview, so batching
 * several into one message would interleave them and Telegram would render one
 * preview for the whole message.
 *
 * The header reflects the real severity. A card for a NORMAL article is built
 * only in the "cards" style, and it says so rather than claiming to be breaking.
 */
export function buildBreakingCard(row: Article): string {
  const level = severity(row);
  const lines: string[] = [];
  lines.push(
    level === "HIGH"
      ? `\u{1F6A8} BREAKING NEWS \u{2014} HIGH`
      : `\u{1F4F0} KHMER24 \u{2014} routine`,
  );
  lines.push(`Category: ${categoryLabel(row)}`);
  lines.push("");
  lines.push(row.title);
  lines.push(`Source: ${publisherName(row)}`);

  const body = cardSummary(row);
  if (body) lines.push(body);

  lines.push("");
  lines.push(`\u{1F1F0}\u{1F1ED} Cambodia impact: ${cambodiaImpact(row)}`);
  lines.push("");
  lines.push(`Source link: ${row.url}`);

  return lines.join("\n").slice(0, TELEGRAM_MAX_LEN);
}
