/**
 * Ingest: accept raw feed entries pushed from the Python fetcher.
 *
 * The Worker cannot poll Google News (it answers Cloudflare's IPs with 503), so
 * the local app does the fetching and pushes here. The Worker keeps all the
 * intelligence - classification, scoring, de-duplication, alerting and
 * delivery - so there is exactly one copy of that logic in the serving path.
 */
import { DEFAULT_LOOKBACK_HOURS } from "./config.ts";
import { insertArticle, ensureSchemaOnce } from "./db.ts";
import { applySourceDefault, classify, isNearDuplicate, scoreArticle, titleHashKey, isJunkTitle, stripSourceSuffix } from "./classify.ts";
// registry.ts is the single source of truth for sources. config.ts holds an
// older copy used by the original pipeline; using it here rejected every new
// source id as unknown.
import { SOURCE_BY_ID, BROAD, CAMBODIA_MARKERS } from "./registry.ts";

export interface IngestEntry {
  source: string;
  title: string;
  link: string;
  published?: string | null;
  age_hours?: number | null;
  summary?: string;
  publisher?: string;
}

export interface IngestResult {
  received: number;
  inserted: number;
  duplicate: number;
  unknown_source: number;
  too_old: number;
  junk: number;
  off_topic: number;
  errors: string[];
}

const AGE_LIMIT = DEFAULT_LOOKBACK_HOURS;

const mentionsCambodia = (text: string): boolean => {
  const low = text.toLowerCase();
  return CAMBODIA_MARKERS.some((m) => low.includes(m));
};

/**
 * Classify and store pushed entries. Mirrors what collectNews() does for
 * locally-fetched articles, minus the network fetch.
 */
export async function ingestEntries(
  db: D1Database,
  entries: IngestEntry[],
  lookbackHours: number = AGE_LIMIT,
): Promise<IngestResult> {
  await ensureSchemaOnce(db);
  const result: IngestResult = {
    received: entries.length, inserted: 0, duplicate: 0,
    unknown_source: 0, too_old: 0, junk: 0, off_topic: 0, errors: [],
  };

  const seen = new Set<string>();
  const recentBySource = new Map<string, string[]>();

  for (const raw of entries) {
    const source = SOURCE_BY_ID[raw.source];
    if (!source) {
      result.unknown_source++;
      continue;
    }
    const title = stripSourceSuffix((raw.title ?? "").trim(), source.label, raw.publisher ?? "");
    // The pusher may carry rows stored before these filters existed, so the
    // cloud re-applies them rather than trusting the sender.
    if (isJunkTitle(title)) {
      result.junk++;
      continue;
    }
    if ((BROAD.has(source.domain) || source.requireCambodia) && !mentionsCambodia(title)) {
      result.off_topic++;
      continue;
    }

    const digest = titleHashKey(title);
    if (seen.has(digest)) {
      result.duplicate++;
      continue;
    }

    // Reject anything outside the window, so a stale push cannot flood alerts.
    const age = typeof raw.age_hours === "number" ? raw.age_hours : null;
    if (age !== null && age > lookbackHours) {
      result.too_old++;
      continue;
    }

    const existing = await db
      .prepare(`SELECT 1 AS x FROM articles WHERE title_hash = ? OR google_url = ? LIMIT 1`)
      .bind(digest, raw.link ?? "")
      .first<{ x: number }>();
    if (existing) {
      result.duplicate++;
      continue;
    }

    if (!recentBySource.has(source.id)) {
      const { results } = await db
        .prepare(`SELECT title FROM articles WHERE source = ? ORDER BY id DESC LIMIT 60`)
        .bind(source.id)
        .all<{ title: string }>();
      recentBySource.set(source.id, (results ?? []).map((r) => r.title));
    }
    if (isNearDuplicate(title, recentBySource.get(source.id)!, 0.5)) {
      result.duplicate++;
      continue;
    }

    const { category, signals } = classify(title);
    const applied = applySourceDefault(category, signals, source.id);
    const score = scoreArticle(applied.category, signals.length, source.tier, age);

    const res = await insertArticle(db, {
      title,
      title_hash: digest,
      // The pusher already resolved the real publisher URL.
      url: raw.link ?? "",
      google_url: raw.link ?? "",
      source: source.id,
      tier: source.tier,
      published: raw.published ?? null,
      age_hours: age,
      category: applied.category,
      score,
      summary: (raw.summary ?? "").slice(0, 1200),
      signals: signals.slice(0, 6).join(", "),
      opportunity: applied.opportunity,
      action: applied.action,
    });

    if (res.inserted) {
      result.inserted++;
      seen.add(digest);
      recentBySource.get(source.id)!.unshift(title);
    } else if ((res.error ?? "").includes("UNIQUE")) {
      result.duplicate++;
    } else {
      result.errors.push(`${source.id}: ${res.error}`);
    }
  }
  return result;
}
