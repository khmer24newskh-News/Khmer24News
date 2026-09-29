/**
 * User preferences: which sections, sources and categories the brief should
 * carry, and how much detail it wants.
 *
 * Stored in D1 as a single `prefs` row per key, so the dashboard and the
 * Telegram menu edit the same settings.
 */
import type { IntelReport } from "./intel.ts";
import type { Article } from "./db.ts";
import { ALL_SOURCES, CLOUD_SOURCES, LISTING_SOURCES, SECTION_META, type Section } from "./registry.ts";
import { CATEGORIES, GENERAL_CATEGORY } from "./config.ts";

export const ALL_SECTIONS: Section[] = [
  "money", "cambodia", "asean", "global", "tech", "competitor", "customer", "opportunity",
];

export const URGENCIES = ["act today", "this week", "watch"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** How streaming alerts are presented. See breaking.ts. */
export const ALERT_STYLES = ["breaking", "cards", "compact"] as const;
export type AlertStylePref = (typeof ALERT_STYLES)[number];

export interface Prefs {
  /** Sections included in the brief. */
  sections: Section[];
  /** Source ids included. */
  sources: string[];
  /** Categories whose signals count as opportunities. */
  categories: string[];
  /** How far back the brief looks, in hours. */
  hours: number;
  /** Drop opportunities below this urgency. */
  minUrgency: Urgency;
  /** Include the AI analyst pass. */
  ai: boolean;
  /** Send the brief automatically at 07:30. */
  autoSend: boolean;
  /** How streaming alerts look. */
  alertStyle: AlertStylePref;
  /** Send nothing but HIGH-severity alerts. */
  breakingOnly: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  sections: [...ALL_SECTIONS],
  sources: ALL_SOURCES.map((s) => s.id),
  categories: [...Object.keys(CATEGORIES), GENERAL_CATEGORY],
  hours: 72,
  minUrgency: "watch",
  ai: true,
  autoSend: true,
  alertStyle: "breaking",
  breakingOnly: false,
};

const asStringArray = (raw: string | null, fallback: string[]): string[] => {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return fallback;
  }
};

const asInt = (raw: string | null, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

const asBool = (raw: string | null, fallback: boolean): boolean => {
  if (raw === null) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

/** Read prefs, filling in defaults and discarding unknown values. */
export async function loadPrefs(db: D1Database): Promise<Prefs> {
  const { results } = await db
    .prepare(`SELECT key, value FROM prefs`)
    .all<{ key: string; value: string }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));

  const validSections = new Set<string>(ALL_SECTIONS);
  const validSources = new Set<string>(ALL_SOURCES.map((s) => s.id));
  const validCategories = new Set<string>([...Object.keys(CATEGORIES), GENERAL_CATEGORY]);

  const sections = asStringArray(map.get("sections") ?? null, DEFAULT_PREFS.sections).filter(
    (s): s is Section => validSections.has(s),
  );
  const sources = asStringArray(map.get("sources") ?? null, DEFAULT_PREFS.sources).filter(
    (s) => validSources.has(s),
  );
  const categories = asStringArray(map.get("categories") ?? null, DEFAULT_PREFS.categories).filter(
    (c) => validCategories.has(c),
  );

  const urgencyRaw = (map.get("min_urgency") ?? "").trim();
  const minUrgency = (URGENCIES as readonly string[]).includes(urgencyRaw)
    ? (urgencyRaw as Urgency)
    : DEFAULT_PREFS.minUrgency;

  const styleRaw = (map.get("alert_style") ?? "").trim();
  const alertStyle = (ALERT_STYLES as readonly string[]).includes(styleRaw)
    ? (styleRaw as AlertStylePref)
    : DEFAULT_PREFS.alertStyle;

  return {
    // Never allow an empty brief: money and the opportunity synthesis always stay.
    sections: sections.length ? sections : ["money", "opportunity"],
    sources: sources.length ? sources : DEFAULT_PREFS.sources,
    categories: categories.length ? categories : DEFAULT_PREFS.categories,
    hours: asInt(map.get("hours") ?? null, DEFAULT_PREFS.hours, 1, 720),
    minUrgency,
    ai: asBool(map.get("ai") ?? null, DEFAULT_PREFS.ai),
    autoSend: asBool(map.get("auto_send") ?? null, DEFAULT_PREFS.autoSend),
    alertStyle,
    breakingOnly: asBool(map.get("breaking_only") ?? null, DEFAULT_PREFS.breakingOnly),
  };
}

export async function savePref(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prefs(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

export async function savePrefs(db: D1Database, prefs: Prefs): Promise<void> {
  const entries: [string, string][] = [
    ["sections", JSON.stringify(prefs.sections)],
    ["sources", JSON.stringify(prefs.sources)],
    ["categories", JSON.stringify(prefs.categories)],
    ["hours", String(prefs.hours)],
    ["min_urgency", prefs.minUrgency],
    ["ai", prefs.ai ? "1" : "0"],
    ["auto_send", prefs.autoSend ? "1" : "0"],
    ["alert_style", prefs.alertStyle],
    ["breaking_only", prefs.breakingOnly ? "1" : "0"],
  ];
  for (const [k, v] of entries) await savePref(db, k, v);
}

const URGENCY_RANK: Record<Urgency, number> = { "act today": 0, "this week": 1, watch: 2 };

/**
 * Drop rows from unwanted sources or categories.
 *
 * This runs on the data, not on rendered text: the rendered lines do not carry
 * a source id, so filtering them would be guesswork.
 */
export function filterRows(rows: Article[], prefs: Prefs): Article[] {
  const sources = new Set(prefs.sources);
  const categories = new Set(prefs.categories);
  return rows.filter((a) => sources.has(a.source) && categories.has(a.category));
}

/**
 * Apply preferences to a built report.
 *
 * Money and the opportunity synthesis are structural, so dropping everything
 * else still leaves something useful. Row-level filtering has already happened
 * via filterRows, so here we only choose sections and trim opportunities.
 */
export function applyPrefs(report: IntelReport, prefs: Prefs): IntelReport {
  const wanted = new Set(prefs.sections);
  const minRank = URGENCY_RANK[prefs.minUrgency];

  const sections = report.sections
    .filter((s) => wanted.has(s.section))
    .map((s) => {
      if (s.section === "opportunity") return s;
      // Sections that were populated purely from now-filtered rows read as
      // "Nothing new", which is honest but noisy. Keep them only if the user
      // asked for that section.
      return s;
    });

  const opportunities = report.opportunities.filter(
    (o) =>
      o.categories.some((c) => prefs.categories.includes(c)) &&
      URGENCY_RANK[o.urgency] <= minRank &&
      (prefs.ai || !o.headline.includes("(AI)")),
  );

  const oppBlock = sections.find((s) => s.section === "opportunity");
  if (oppBlock) {
    oppBlock.lines = opportunities.length
      ? opportunities.flatMap((o, i) => [
          `${i + 1}. [${o.urgency.toUpperCase()}] ${o.headline}`,
          `   Why: ${o.because.join("; ")}`,
          `   Customer: ${o.customer}`,
          `   ACTION: ${o.action}`,
        ])
      : ["- Nothing above your urgency threshold. Lower it in Settings to see more."];
    oppBlock.empty = opportunities.length === 0;
  }

  return { ...report, sections, opportunities };
}

/** Sources grouped for the settings UI. */
export function sourcesByGroup(): { title: string; items: { id: string; label: string; how: string }[] }[] {
  const describe = (s: (typeof ALL_SOURCES)[number]): string =>
    s.discovery === "rss"
      ? "publisher feed"
      : s.discovery === "bing"
        ? "Bing News topic"
        : "no feed yet";
  return [
    { title: "Cambodia - official topics", items: CLOUD_SOURCES.filter((s) => s.section === "cambodia" && s.discovery === "bing").map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
    { title: "Cambodia - press", items: CLOUD_SOURCES.filter((s) => s.section === "cambodia" && s.discovery === "rss").map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
    { title: "ASEAN", items: ALL_SOURCES.filter((s) => s.section === "asean").map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
    { title: "Global", items: ALL_SOURCES.filter((s) => s.section === "global").map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
    { title: "AI & Technology", items: CLOUD_SOURCES.filter((s) => s.section === "tech").map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
    { title: "Competitors", items: LISTING_SOURCES.map((s) => ({ id: s.id, label: s.label, how: describe(s) })) },
  ];
}

export { SECTION_META };
