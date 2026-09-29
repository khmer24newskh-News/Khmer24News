/**
 * Streaming alerts: send every article the moment its source publishes it,
 * instead of waiting for the daily digest.
 *
 * The watermark is the article id, so restarts and clock changes cannot cause
 * duplicates or gaps. A failed send deliberately leaves the watermark alone so
 * the next tick retries the same articles.
 */
import {
  DEFAULT_ALERT_BATCH_SIZE,
  DEFAULT_ALERT_MAX_PER_TICK,
} from "./config.ts";
import { articlesAfter, countPendingAlerts, getWatermark, setWatermark, type Article } from "./db.ts";
import { loadPrefs } from "./prefs.ts";
import { buildAlertMessages, type AlertStyle } from "./report.ts";
import { sendTelegram } from "./telegram.ts";
import type { Env } from "./env.ts";

export interface AlertResult {
  /** first run: watermark primed, nothing sent */
  backfilled: boolean;
  sentMessages: number;
  sentArticles: number;
  pending: number;
  watermark: number | null;
  error: string | null;
}

export interface AlertOptions {
  perMessage?: number;
  maxPerTick?: number;
  dryRun?: boolean;
  /** "breaking" (default) = cards for HIGH, compact for the rest. */
  style?: AlertStyle;
  /** When true, only HIGH articles are sent at all. */
  breakingOnly?: boolean;
}

export async function sendNewArticleAlerts(
  env: Env,
  opts: AlertOptions = {},
): Promise<AlertResult> {
  const perMessage = opts.perMessage ?? DEFAULT_ALERT_BATCH_SIZE;
  const maxPerTick = opts.maxPerTick ?? DEFAULT_ALERT_MAX_PER_TICK;

  const result: AlertResult = {
    backfilled: false, sentMessages: 0, sentArticles: 0,
    pending: 0, watermark: null, error: null,
  };

  const watermark = await getWatermark(env.DB);
  if (watermark === null) {
    // Enabling alerts must not dump the whole LOOKBACK_HOURS backlog at once.
    const row = await env.DB.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM articles`)
      .first<{ m: number }>();
    const mark = row?.m ?? 0;
    await setWatermark(env.DB, mark);
    return { ...result, backfilled: true, watermark: mark };
  }
  result.watermark = watermark;

  const rows = await articlesAfter(env.DB, watermark, maxPerTick);
  if (rows.length === 0) {
    result.pending = 0;
    return result;
  }

  // Read here rather than at each call site, so the style set in /settings is
  // honoured by the cron, /alerts, /collect-cloud and /ingest alike.
  const prefs = await loadPrefs(env.DB);
  const style = opts.style ?? prefs.alertStyle;
  const breakingOnly = opts.breakingOnly ?? prefs.breakingOnly;

  // A card has its own headline, category and single link, so it cannot share a
  // message. Batching the remainder is what keeps the volume sane.
  const messages = buildAlertMessages(rows, perMessage, style);
  const sendable = breakingOnly ? messages.filter((m) => m.linkPreview) : messages;
  const articlesSent = breakingOnly
    ? sendable.reduce((n, m) => n + m.articles, 0)
    : rows.length;

  if (opts.dryRun) {
    result.sentArticles = articlesSent;
    result.sentMessages = sendable.length;
    result.pending = await countPendingAlerts(env.DB);
    return result;
  }

  for (const msg of sendable) {
    const r = await sendTelegram(env, msg.text, { linkPreview: msg.linkPreview });
    if (!r.ok) {
      // Do not advance: the same articles are retried next tick.
      result.error = r.detail;
      result.pending = await countPendingAlerts(env.DB);
      return result;
    }
    result.sentMessages++;
  }

  result.sentArticles = articlesSent;
  await setWatermark(env.DB, rows[rows.length - 1]!.id);
  result.watermark = rows[rows.length - 1]!.id;
  result.pending = await countPendingAlerts(env.DB);
  return result;
}

/** Mute alerts until the next new article, without deleting stored articles. */
export async function resetAlertWatermark(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM articles`)
    .first<{ m: number }>();
  const mark = row?.m ?? 0;
  await setWatermark(env.DB, mark);
  return mark;
}

export async function pendingAlerts(env: Env, limit?: number): Promise<Article[]> {
  const mark = await getWatermark(env.DB);
  if (mark === null) return [];
  return articlesAfter(env.DB, mark, limit ?? DEFAULT_ALERT_MAX_PER_TICK);
}
