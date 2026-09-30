/**
 * D1 storage. Mirrors the SQLite schema from the Python version.
 * All queries are parameterised; no string interpolation of user input.
 */
import { GENERAL_CATEGORY, PLAYBOOK } from "./config.ts";

export interface Article {
  id: number;
  title: string;
  title_hash: string;
  url: string;
  google_url: string;
  source: string;
  tier: number;
  published: string | null;
  age_hours: number | null;
  category: string;
  score: number;
  summary: string | null;
  signals: string | null;
  opportunity: string;
  action: string;
  created_at: string;
}

export interface NewArticle {
  title: string;
  title_hash: string;
  url: string;
  google_url: string;
  source: string;
  tier: number;
  published: string | null;
  age_hours: number | null;
  category: string;
  score: number;
  summary: string;
  signals: string;
  opportunity: string;
  action: string;
}

/** RFC 3339 timestamp `hours` in the past, matching the ISO text stored by Python. */
export function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function ensureSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS articles(
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         title        TEXT NOT NULL,
         title_hash   TEXT NOT NULL,
         url          TEXT,
         google_url   TEXT,
         source       TEXT,
         tier         INTEGER DEFAULT 1,
         published    TEXT,
         age_hours    REAL,
         category     TEXT,
         score        INTEGER DEFAULT 0,
         summary      TEXT,
         signals      TEXT,
         opportunity  TEXT,
         action       TEXT,
         created_at   TEXT
       )`,
    )
    .run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_title_hash ON articles(title_hash)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS prefs(key TEXT PRIMARY KEY, value TEXT)`).run();
}

/**
 * Run ensureSchema at most once per isolate. Without this the very first HTTP
 * request against a fresh database fails with "no such table: articles",
 * because the DDL only used to run in the cron handler.
 *
 * Idempotent, so it is safe to re-run when an isolate is recycled.
 */
let schemaPromise: Promise<void> | null = null;
export function ensureSchemaOnce(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(db).catch((err) => {
      schemaPromise = null; // let the next request retry
      throw err;
    });
  }
  return schemaPromise;
}

export async function getArticles(
  db: D1Database,
  opts: { limit?: number; hours?: number; category?: string } = {},
): Promise<Article[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.hours) {
    where.push("(published IS NULL OR published >= ?)");
    params.push(isoHoursAgo(opts.hours));
  }
  if (opts.category && opts.category !== "all") {
    where.push("category = ?");
    params.push(opts.category);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const { results } = await db
    .prepare(
      `SELECT * FROM articles ${clause}
       ORDER BY score DESC, published DESC, id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<Article>();
  return results ?? [];
}

export async function categoryCounts(
  db: D1Database,
  hours: number,
): Promise<{ category: string; n: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT category, COUNT(*) AS n FROM articles
       WHERE published >= ?
       GROUP BY category ORDER BY n DESC, category`,
    )
    .bind(isoHoursAgo(hours))
    .all<{ category: string; n: number }>();
  return results ?? [];
}

export async function recentTitlesForSource(
  db: D1Database,
  source: string,
  hours: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT title FROM articles WHERE source = ? AND published >= ?
       ORDER BY id DESC LIMIT 60`,
    )
    .bind(source, isoHoursAgo(hours))
    .all<{ title: string }>();
  return (results ?? []).map((r) => r.title);
}

export async function existsByHashOrGoogleUrl(
  db: D1Database,
  titleHash: string,
  googleUrl: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM articles WHERE title_hash = ? OR google_url = ? LIMIT 1`)
    .bind(titleHash, googleUrl)
    .first<{ x: number }>();
  return row !== null;
}

export interface InsertResult {
  inserted: boolean;
  error: string | null;
}

export async function insertArticle(db: D1Database, a: NewArticle): Promise<InsertResult> {
  try {
    await db
      .prepare(
        `INSERT INTO articles
           (title, title_hash, url, google_url, source, tier, published, age_hours,
            category, score, summary, signals, opportunity, action, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        a.title, a.title_hash, a.url, a.google_url, a.source, a.tier, a.published, a.age_hours,
        a.category, a.score, a.summary, a.signals, a.opportunity, a.action,
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      )
      .run();
    return { inserted: true, error: null };
  } catch (err) {
    // Unique index on title_hash: a concurrent run beat us to it.
    return { inserted: false, error: (err as Error).message };
  }
}

export async function countAll(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM articles`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function purgeOlderThan(db: D1Database, days: number): Promise<number> {
  const cutoff = isoHoursAgo(days * 24);
  const res = await db.prepare(`DELETE FROM articles WHERE published IS NOT NULL AND published < ?`)
    .bind(cutoff)
    .run();
  return res.meta?.changes ?? 0;
}

export const isPlaybookCategory = (category: string): boolean =>
  category in PLAYBOOK && category !== GENERAL_CATEGORY;

// ---------------------------------------------------------------------------
// Streaming alerts
// ---------------------------------------------------------------------------

/**
 * The alert watermark is the article id, not a timestamp: ids are monotonic and
 * immune to clock changes and DST, so nothing is missed or repeated across
 * restarts.
 */
/**
 * Record that a cron tick actually happened, keyed by its expression.
 *
 * A single "last run" value is structurally useless when two crons are
 * registered: the 10-minute poll overwrites the record every 10 minutes, so the
 * daily brief's last run becomes unrecoverable within minutes. That is exactly
 * how a missed 07:30 brief went unnoticed - the one number that mattered was
 * the one that could never be read.
 *
 * Keys are `cron:last:<expression>`, so each schedule is tracked separately.
 */
export async function setCronHeartbeat(
  db: D1Database,
  cron: string,
  detail?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const rows: [string, string][] = [
    [`cron:last:${cron || "(unnamed)"}`, now],
    ["cron:last_any", now],
  ];
  if (detail) rows.push(["cron:last_detail", detail]);
  for (const [key, value] of rows) {
    await db
      .prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value)
      .run();
  }
}

/**
 * Record the outcome of a daily-brief attempt.
 *
 * Without this, a failed send is indistinguishable from a send nobody read.
 */
export async function recordDailyAttempt(
  db: D1Database,
  ok: boolean,
  detail: string,
): Promise<void> {
  const now = new Date().toISOString();
  const rows: [string, string][] = [
    ["daily:last_attempt", now],
    ["daily:last_ok", ok ? "1" : "0"],
    ["daily:last_detail", detail.slice(0, 300)],
  ];
  for (const [key, value] of rows) {
    await db
      .prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value)
      .run();
  }
}

export interface CronHealth {
  lastRun: string | null;
  expression: string | null;
  detail: string;
  /** Whole minutes since the last tick, or null if it has never run. */
  ageMinutes: number | null;
  /** True when the gap is longer than a 10-minute cron can explain. */
  stale: boolean;
  /** Last run time per registered cron expression. */
  perCron: Record<string, { at: string; minutesAgo: number | null }>;
  daily: {
    lastAttempt: string | null;
    ok: boolean | null;
    detail: string;
    /** Hours since the last successful brief, or null if it has never succeeded. */
    hoursSinceOk: number | null;
  };
  /** The last phase failure, or "" when every phase is healthy. */
  lastError: string;
}

/**
 * How late a tick can be before it counts as stale.
 *
 * Generous on purpose. A tick can be skipped if the Worker was busy or the
 * platform was degraded, so this should mean "look at this", not "something is
 * definitely broken".
 */
const CRON_STALE_MINUTES = 25;

export async function cronHealth(db: D1Database): Promise<CronHealth> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM meta
       WHERE key LIKE 'cron:%' OR key LIKE 'daily:%'
          OR key IN ('cron_last_run', 'cron_last_expression', 'cron_last_detail',
                     'cron_last_error')`,
    )
    .all<{ key: string; value: string }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));

  const minutesAgo = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 60_000);
  };

  const perCron: CronHealth["perCron"] = {};
  for (const [key, value] of map) {
    if (!key.startsWith("cron:last:")) continue;
    const expr = key.slice("cron:last:".length);
    perCron[expr] = { at: value, minutesAgo: minutesAgo(value) };
  }

  const ageMinutes = minutesAgo(map.get("cron:last_any") ?? null);
  const okRaw = map.get("daily:last_ok");
  const lastOkAt = okRaw === "1" ? map.get("daily:last_attempt") ?? null : null;

  return {
    // Falls back to the pre-migration key. Without this, deploying the
    // per-schedule heartbeat makes /health report a stale cron until the first
    // tick lands - a false alarm on the one check people are told to trust.
    lastRun: map.get("cron:last_any") ?? map.get("cron_last_run") ?? null,
    expression: map.get("cron_last_expression") ?? null,
    detail: map.get("cron_last_detail") ?? "",
    ageMinutes: ageMinutes ?? minutesAgo(map.get("cron_last_run") ?? null),
    stale:
      (ageMinutes ?? minutesAgo(map.get("cron_last_run") ?? null)) === null ||
      (ageMinutes ?? minutesAgo(map.get("cron_last_run") ?? null))! > CRON_STALE_MINUTES,
    perCron,
    daily: {
      lastAttempt: map.get("daily:last_attempt") ?? null,
      ok: okRaw === undefined ? null : okRaw === "1",
      detail: map.get("daily:last_detail") ?? "",
      hoursSinceOk: minutesAgo(lastOkAt) === null ? null : Math.floor(minutesAgo(lastOkAt)! / 60),
    },
    lastError: map.get("cron:last_error") ?? "",
  };
}

export async function getWatermark(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM meta WHERE key = 'alert_watermark_id'`)
    .first<{ value: string }>();
  if (!row || row.value === null || row.value === undefined) return null;
  const n = Number(row.value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function setWatermark(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta(key, value) VALUES('alert_watermark_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(String(id))
    .run();
}

/** Alert order must be publication order, so ASC by id. */
export async function articlesAfter(
  db: D1Database,
  afterId: number,
  limit: number,
): Promise<Article[]> {
  const { results } = await db
    .prepare(`SELECT * FROM articles WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .bind(afterId, limit)
    .all<Article>();
  return results ?? [];
}

export async function countPendingAlerts(db: D1Database): Promise<number> {
  const mark = await getWatermark(db);
  if (mark === null) return 0;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE id > ?`)
    .bind(mark)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
