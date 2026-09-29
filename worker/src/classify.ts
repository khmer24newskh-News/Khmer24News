/**
 * Classification, scoring and de-duplication.
 * Pure functions - no I/O - so they are unit-testable outside the Worker.
 */
import {
  CATEGORIES,
  GENERAL_CATEGORY,
  GENERAL_PLAYBOOK,
  PLAYBOOK,
  JUNK_PHRASES,
  JUNK_TITLES,
  SOURCE_BY_NAME,
  hostOf,
  type Playbook,
} from "./config.ts";

const WS = /\s+/g;
const PUNCT = /[^\p{L}\p{N}\s]+/gu;

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(PUNCT, " ").replace(WS, " ").trim();
}

/** Strip the " - <publisher>" suffix Google appends to every headline. */
export function stripSourceSuffix(title: string, sourceName: string, publisher: string): string {
  const clean = title.replace(WS, " ").trim();
  const aliases = [publisher, sourceName, SOURCE_BY_NAME[sourceName] ? hostOf(SOURCE_BY_NAME[sourceName]!.home) : ""]
    .filter((a) => a && a.length > 0);
  // Longest alias first, so "Cambodian Investment Board (CIB)" wins over "CIB / CDC".
  for (const alias of [...new Set(aliases)].sort((a, b) => b.length - a.length)) {
    for (const sep of [" - ", " – ", " | ", " — "]) {
      if (clean.endsWith(sep + alias)) {
        return clean.slice(0, -(sep.length + alias.length)).trim();
      }
    }
  }
  return clean;
}

const junkPhraseRe = new RegExp(
  `^[\\d\\s]*(${JUNK_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  "i",
);

export function isJunkTitle(title: string): boolean {
  const s = title.trim();
  if (!s || s.length < 8) return true;
  const low = s.toLowerCase();
  if (JUNK_TITLES.has(low)) return true;
  if (/^[*\W_]+$/.test(s)) return true;
  const letters = [...s].filter((c) => /\p{L}/u.test(c)).length;
  if (letters < Math.max(4, Math.floor(s.length / 3))) return true;
  if (junkPhraseRe.test(low)) return true;
  if (s.length <= 40 && JUNK_PHRASES.some((p) => low === p || low.startsWith(p + " "))) return true;
  return false;
}

const isAscii = (s: string) => /^[\x00-\x7F]+$/.test(s);

/** Word-boundary for ASCII, plain substring for Khmer. */
function keywordHit(keyword: string, text: string, padded: string): boolean {
  if (isAscii(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  }
  return padded.includes(keyword);
}

export interface Classification {
  category: string;
  signals: string[];
}

/** Classify a headline. Keyword matches only - never the Google summary. */
export function classify(title: string, summary = ""): Classification {
  const text = ` ${normalizeTitle(title)} `;
  const padded = `${title} ${summary}`.toLowerCase();

  let best: Classification = { category: GENERAL_CATEGORY, signals: [] };
  let bestCount = 0;
  for (const [category, keywords] of Object.entries(CATEGORIES)) {
    const signals = keywords.filter((kw) => keywordHit(kw, text, padded));
    if (signals.length > bestCount) {
      best = { category, signals };
      bestCount = signals.length;
    }
  }
  return best;
}

/**
 * 0-100, deliberately non-saturating so the ranking stays meaningful.
 *   keyword strength 0-45 | source authority 0-20 | recency 0-25 | playbook 0-10
 */
export function scoreArticle(category: string, signalCount: number, tier: number, ageHours: number | null): number {
  const keywordScore = ({ 0: 0, 1: 12, 2: 26, 3: 38 } as Record<number, number>)[signalCount] ?? 45;
  const authority = tier <= 1 ? 20 : 14;
  let recency: number;
  if (ageHours === null) recency = 0;
  else if (ageHours <= 6) recency = 25;
  else if (ageHours <= 24) recency = 20;
  else if (ageHours <= 48) recency = 12;
  else if (ageHours <= 24 * 7) recency = 5;
  else recency = 0;
  const playbook = PLAYBOOK[category] ? 10 : 0;
  return Math.min(100, keywordScore + authority + recency + playbook);
}

export function businessAction(category: string, signals: string[]): Playbook {
  if (category === GENERAL_CATEGORY) return GENERAL_PLAYBOOK;
  const base = PLAYBOOK[category] ?? GENERAL_PLAYBOOK;
  if (signals.length === 0) return base;
  return [base[0], `${base[1]} Watch for: ${signals.slice(0, 4).join(", ")}.`];
}

/**
 * Apply the source's own remit when nothing matched, and label it honestly.
 * The domain filter already guarantees the article is on-topic for that body.
 */
export function applySourceDefault(
  category: string,
  signals: string[],
  sourceName: string,
): { category: string; opportunity: string; action: string } {
  if (category === GENERAL_CATEGORY) {
    const fallback = SOURCE_BY_NAME[sourceName]?.defaultCategory;
    if (fallback) {
      const [opportunity, action] = businessAction(fallback, signals);
      return {
        category: fallback,
        opportunity,
        action: `${action} (default category for ${sourceName}; no keyword matched)`,
      };
    }
  }
  const [opportunity, action] = businessAction(category, signals);
  return { category, opportunity, action };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "will",
  "have", "has", "was", "were", "are", "its", "their", "after", "before", "under",
  "about", "says", "said", "new", "amid", "here",
]);

export function contentTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((t) => t.length > 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

/**
 * Best-effort catch for the same story republished under a slightly different
 * headline by the same source. Word-overlap heuristic, not semantic dedup.
 */
export function isNearDuplicate(
  title: string,
  recentTitlesFromSameSource: string[],
  threshold: number,
): boolean {
  const tokens = contentTokens(title);
  if (tokens.size < 3) return false;
  for (const other of recentTitlesFromSameSource) {
    const otherTokens = contentTokens(other);
    if (otherTokens.size === 0) continue;
    let shared = 0;
    for (const t of tokens) if (otherTokens.has(t)) shared++;
    if (shared > 0 && shared / Math.min(tokens.size, otherTokens.size) >= threshold) return true;
  }
  return false;
}

/** Exact-match key for a headline. */
export function titleHashKey(title: string): string {
  return normalizeTitle(title);
}

export function prettyAge(ageHours: number | null): string {
  if (ageHours === null) return "date unknown";
  if (ageHours < 1) return `${Math.max(1, Math.round(ageHours * 60))} min ago`;
  if (ageHours < 48) return `${Math.round(ageHours)} h ago`;
  return `${Math.round(ageHours / 24)} d ago`;
}

export function mentionsCambodia(text: string): boolean {
  const low = text.toLowerCase();
  return ["cambodia", "cambodian", "phnom penh", "កម្ពុជា", "ភ្នំពេញ"].some((m) => low.includes(m));
}
