/**
 * Khmer24 Business Intelligence - Cloudflare Worker.
 *
 * Replaces the Flask + SQLite + Task Scheduler version. The interesting parts:
 *  - `scheduled`  : Cron Trigger, fetches news and sends the Telegram report.
 *  - `/collect`   : manual fetch (admin key required)
 *  - `/send`      : manual send (admin key required)
 *  - `/`          : public read-only dashboard
 *
 * ADMIN_TOKEN is a Worker secret. Any endpoint that costs money, sends a
 * Telegram message or writes to the database requires it, otherwise anyone who
 * finds this URL could use your bot to spam any chat.
 */
import {
  DEFAULT_ALERT_BATCH_SIZE,
  DEFAULT_ALERT_MAX_PER_TICK,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_MAX_ITEMS_PER_SOURCE,
  DEFAULT_MAX_RESOLVES,
} from "./config.ts";
import { categoryCounts, countAll, ensureSchemaOnce, getArticles, purgeOlderThan } from "./db.ts";
import { collectNews } from "./collect.ts";
import { renderDashboard, type Flash } from "./html.ts";
import { sendTelegram, telegramCheck, telegramConfigured } from "./telegram.ts";
import { resetAlertWatermark, sendNewArticleAlerts, pendingAlerts } from "./alerts.ts";
import { ingestEntries, type IngestEntry } from "./ingest.ts";
import { buildAlertMessages, buildDailyReport, summariseStats } from "./report.ts";
import { buildIntelReport, renderIntelMessages, applyAnalysis } from "./intel.ts";
import { runAnalyst, DEFAULT_AI_MODEL, type AiAnalysis } from "./analyst.ts";
import { renderIntel } from "./intelhtml.ts";
import { fetchFxRates } from "./market.ts";
import { fetchAllCloudSources, unwrapBingUrl } from "./cloudfeeds.ts";
import { CLOUD_SOURCES, LISTING_SOURCES, SOURCE_BY_ID, type Section } from "./registry.ts";
import { countPendingAlerts, cronHealth, recordDailyAttempt, setCronHeartbeat } from "./db.ts";
import { renderSettings } from "./settingshtml.ts";
import { probeAlternatives, probeGoogle, tuneFeeds, tuneQueries, winner } from "./diag.ts";
import {
  DEFAULT_PREFS, applyPrefs, filterRows, loadPrefs, savePrefs, type Prefs,
} from "./prefs.ts";
import { buildStatus } from "./status.ts";
import {
  buildSectionFooter, buildSectionPicker, CLOSE, MENU_PREFIX, SECTION_PREFIX, NO_KEYBOARD, SEND_NOW, buildAndSendBrief, buildKeyboardWithUrl,
  editMessageText, handleToggle, menuCaption, renderSectionView, sendWithMenu, setWebhook, webhookInfo,
} from "./telegrammenu.ts";
import type { Env } from "./env.ts";

/** Sources fetched as Bing News topics, for the coverage note in the brief. */
const BING_SOURCES = CLOUD_SOURCES.filter((s) => s.discovery === "bing");

/** How many stored signals sit in each report section, for the settings page. */
async function sectionCounts(db: D1Database): Promise<Record<string, number>> {
  const rows = await getArticles(db, { limit: 500, hours: 720 });
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const section = (SOURCE_BY_ID[r.source]?.section ?? "cambodia") as Section;
    counts[section] = (counts[section] ?? 0) + 1;
  }
  return counts;
}

/**
 * Honest reporting of what is not covered, so a thin report says why instead
 * of silently omitting a section.
 */
function coverageWarnings(): string[] {
  const w: string[] = [];
  // The Cambodia/ASEAN sections are topic queries rather than single publishers,
  // so a story may come from a different outlet than the section name suggests.
  // Worth saying, otherwise it looks like a mislabel.
  if (BING_SOURCES.length > 0) {
    w.push(
      `${BING_SOURCES.length} Cambodia/ASEAN sections are news-topic searches, so the outlet in a headline may differ from the section topic`,
    );
  }
  if (LISTING_SOURCES.length > 0) {
    const names = LISTING_SOURCES.map((s) => s.label.split(" ")[0]).join(", ");
    w.push(`competitor platforms (${names}) publish no RSS, so they are not yet tracked`);
  }
  w.push("oil and gold need a paid API key");
  return w;
}

export type { Env };

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const lookback = (env: Env) => num(env.LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS);

/** Constant-time-ish compare. ADMIN_TOKEN is required, there is no default. */
function isAdmin(request: Request, env: Env, url: URL): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const supplied =
    url.searchParams.get("key") ??
    request.headers.get("X-Admin-Token") ??
    "";
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return diff === 0;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/**
 * Has the daily brief gone unsent for long enough to be worth retrying?
 *
 * A brief is expected roughly every 24 hours. Waiting a further few hours before
 * catching up means a missed run is a delay rather than a loss, while still
 * leaving a clear margin so an ordinary late tick is not mistaken for an outage.
 */
const DAILY_INTERVAL_HOURS = 24;
const DAILY_GRACE_HOURS = 6;

export async function dailyBriefOverdue(
  db: D1Database,
): Promise<{ overdue: boolean; hoursSinceOk: number | null }> {
  const health = await cronHealth(db);
  // Never sent, or the last attempt failed: due as soon as the clock allows.
  if (health.daily.hoursSinceOk === null) {
    return { overdue: health.daily.lastAttempt !== null, hoursSinceOk: null };
  }
  const due = health.daily.hoursSinceOk > DAILY_INTERVAL_HOURS + DAILY_GRACE_HOURS;
  return { overdue: due, hoursSinceOk: health.daily.hoursSinceOk };
}

export interface DailyBriefResult {
  sent: number;
  messages: number;
  opportunities: number;
  skipped: boolean;
  detail: string;
}

/**
 * Build and send the brief, recording the outcome either way.
 *
 * Recording is not optional decoration. A brief that fails silently is
 * indistinguishable from one that was never due, which is precisely how this went
 * unnoticed: the report was being built and the sends were failing, and nothing
 * wrote that down.
 */
export async function sendDailyBrief(env: Env, label: string): Promise<DailyBriefResult> {
  // Always awaited: an unawaited write at the end of a cron tick can be cut off
  // when the isolate is recycled, which would lose the very record this exists
  // to keep.
  const fail = async (detail: string, skipped = false): Promise<DailyBriefResult> => {
    console.log(`${label} brief ${skipped ? "skipped" : "FAILED"}: ${detail}`);
    try {
      await recordDailyAttempt(env.DB, !skipped, detail);
    } catch (err) {
      console.log(`${label} could not record the outcome: ${(err as Error).message}`);
    }
    return { sent: 0, messages: 0, opportunities: 0, skipped, detail };
  };

  let prefs;
  try {
    prefs = await loadPrefs(env.DB);
  } catch (err) {
    return fail(`prefs unreadable: ${(err as Error).message}`);
  }
  if (!prefs.autoSend) {
    return fail("auto-send is off in settings", true);
  }

  let messages: string[];
  let opportunities = 0;
  try {
    const stored = await getArticles(env.DB, { limit: 200, hours: prefs.hours });
    const rows = filterRows(stored, prefs);
    const fx = await fetchFxRates();
    let report = buildIntelReport(rows, fx, coverageWarnings());
    // The rule engine is the backbone, so an AI failure still yields a full report.
    if (prefs.ai) {
      const ai = await runAnalyst(env, rows, fx);
      applyAnalysis(report, ai);
      console.log(
        `${label} analyst: used=${ai.used} reason=${ai.reason} ` +
          `tokens=${ai.tokensIn + ai.tokensOut} opps=${ai.opportunities.length}`,
      );
    }
    report = applyPrefs(report, prefs);
    opportunities = report.opportunities.length;
    messages = renderIntelMessages(report);
  } catch (err) {
    return fail(`build threw: ${(err as Error).name}: ${(err as Error).message}`);
  }

  let sent = 0;
  for (const text of messages) {
    const r = await sendTelegram(env, text);
    if (!r.ok) return fail(`telegram: ${r.detail}`);
    sent++;
  }
  const detail = `${sent} message(s), ${opportunities} opportunities`;
  console.log(`${label} brief sent: ${detail}`);
  try {
    await recordDailyAttempt(env.DB, true, detail);
  } catch (err) {
    console.log(`${label} could not record the outcome: ${(err as Error).message}`);
  }
  return { sent, messages: messages.length, opportunities, skipped: false, detail };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const admin = isAdmin(request, env, url);
    const flashes: Flash[] = [];

    // Cron invocations and any internal call arrive with this header.
    const fromCron = request.headers.get("X-Cron-Internal") === env.ADMIN_TOKEN;

    try {
      // Self-healing: a fresh D1 database has no tables, so create them on the
      // first request rather than requiring a manual migration step.
      await ensureSchemaOnce(env.DB);

      switch (true) {
        case path === "/health": {
          const cron = await cronHealth(env.DB);
          // The brief is expected every ~24h. Anything past 30h means you have
          // missed one, and that is worth shouting about rather than reporting
          // ok:true next to a stale number.
          const briefMissed =
            cron.daily.lastAttempt !== null &&
            (cron.daily.hoursSinceOk === null || cron.daily.hoursSinceOk > 30);
          return json({
            ok: !cron.stale && !briefMissed,
            platform: "cloudflare-worker",
            articles: await countAll(env.DB),
            telegram_configured: telegramConfigured(env),
            lookback_hours: lookback(env),
            stream_alerts: strFlag(env.STREAM_ALERTS, true),
            pending_alerts: await countPendingAlerts(env.DB),
            admin_token_set: Boolean(env.ADMIN_TOKEN),
            cron_last_run: cron.lastRun,
            cron_minutes_since_run: cron.ageMinutes,
            cron_stale: cron.stale,
            // Per schedule, because one shared value cannot answer "did the
            // daily run?" once a faster cron keeps overwriting it.
            cron_per_schedule: cron.perCron,
            daily_brief: {
              last_attempt: cron.daily.lastAttempt,
              last_ok: cron.daily.ok,
              hours_since_last_ok: cron.daily.hoursSinceOk,
              detail: cron.daily.detail,
            },
            ...(cron.lastError ? { cron_last_error: cron.lastError } : {}),
            ...(cron.stale
              ? {
                  warning:
                    "The 10-minute cron has not run recently, so no new articles are arriving. " +
                    "Check the crons in wrangler.toml and redeploy.",
                }
              : {}),
            ...(briefMissed
              ? {
                  warning:
                    `The daily brief has not been sent successfully for ` +
                    `${cron.daily.hoursSinceOk === null ? "over a day" : `${cron.daily.hoursSinceOk} hours`}. ` +
                    "Last detail: " + (cron.daily.detail || "none recorded"),
                }
              : {}),
          });
        }

        case path === "/check": {
          const lines = await telegramCheck(env);
          if (url.searchParams.get("json") === "1") {
            return json({ ok: lines.every((l) => l.ok), lines });
          }
          const html = lines
            .map(
              (l) =>
                `<div class="flash flash-${l.ok ? "ok" : "error"}">${l.ok ? "[x]" : "[ ]"} ${escapeHtml(l.text)}</div>`,
            )
            .join("");
          return new Response(
            `<!doctype html><meta charset="utf-8"><title>Telegram check</title>
<body style="font-family:Segoe UI,Arial;max-width:760px;margin:40px auto;padding:0 16px">
<h1>Telegram configuration</h1>${html}
<p><a href="/">← Dashboard</a></p></body>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }

        case path === "/collect": {
          if (!admin && !fromCron) return json({ error: "unauthorised" }, 401);
          const res = await collectNews(env.DB, {
            lookbackHours: lookback(env),
            maxItemsPerSource: num(env.MAX_ITEMS_PER_SOURCE, DEFAULT_MAX_ITEMS_PER_SOURCE),
            maxResolves: num(env.MAX_RESOLVES, DEFAULT_MAX_RESOLVES),
            dupOverlap: Number(env.DUP_OVERLAP ?? 0.5) || 0.5,
          });
          ctx.waitUntil(
            (async () => {
              const days = Number(env.PURGE_AFTER_DAYS ?? 0);
              if (days > 0) await purgeOlderThan(env.DB, days);
            })(),
          );
          const summary = summariseStats(res);
          if (url.searchParams.get("json") === "1") return json(res);
          flashes.push({ kind: res.newCount > 0 ? "ok" : "info", text: `Collected: ${summary}` });
          for (const e of res.errors.slice(0, 5)) flashes.push({ kind: "error", text: e });
          return redirect("/?flashes=" + encodeURIComponent(JSON.stringify(flashes)));
        }

        case path === "/send": {
          if (!admin && !fromCron) return json({ error: "unauthorised" }, 401);
          const messages = await buildDailyReport(env.DB, { hours: lookback(env) });
          const results = [];
          for (const text of messages) {
            const r = await sendTelegram(env, text);
            results.push({ ok: r.ok, detail: r.detail });
            if (!r.ok) break; // stop at the first failure rather than hammering the API
          }
          if (url.searchParams.get("json") === "1") return json({ messages: results });
          for (const r of results) flashes.push({ kind: r.ok ? "ok" : "error", text: r.detail });
          return redirect("/?flashes=" + encodeURIComponent(JSON.stringify(flashes)));
        }

        case path === "/run": {
          // Collect then send, in one request. The cron handler calls this too.
          if (!admin && !fromCron) return json({ error: "unauthorised" }, 401);
          const res = await collectNews(env.DB, {
            lookbackHours: lookback(env),
            maxItemsPerSource: num(env.MAX_ITEMS_PER_SOURCE, DEFAULT_MAX_ITEMS_PER_SOURCE),
            maxResolves: num(env.MAX_RESOLVES, DEFAULT_MAX_RESOLVES),
          });
          const messages = await buildDailyReport(env.DB, { hours: lookback(env) });
          const sent = [];
          for (const text of messages) {
            const r = await sendTelegram(env, text);
            sent.push({ ok: r.ok, detail: r.detail });
            if (!r.ok) break;
          }
          const payload = { collect: res, summary: summariseStats(res), sent };
          if (url.searchParams.get("json") === "1") return json(payload);
          flashes.push({ kind: res.newCount > 0 ? "ok" : "info", text: `Collected: ${summariseStats(res)}` });
          for (const e of res.errors.slice(0, 5)) flashes.push({ kind: "error", text: e });
          for (const s of sent) flashes.push({ kind: s.ok ? "ok" : "error", text: s.detail });
          return redirect("/?flashes=" + encodeURIComponent(JSON.stringify(flashes)));
        }

        case path === "/preview": {
          // Builds the report and shows it without sending anything.
          // Useful for checking formatting and the 4096-char split safely.
          if (!admin) return json({ error: "unauthorised - pass ?key=ADMIN_TOKEN" }, 401);
          const messages = await buildDailyReport(env.DB, { hours: lookback(env) });
          if (url.searchParams.get("json") === "1") {
            return json({ count: messages.length, messages, lengths: messages.map((m) => m.length) });
          }
          return new Response(
            `<!doctype html><meta charset="utf-8"><title>Report preview</title>
<body style="font-family:Segoe UI,Arial;max-width:820px;margin:32px auto;padding:0 16px">
<h1>Report preview (${messages.length} message${messages.length === 1 ? "" : "s"})</h1>
${messages
  .map(
    (m, i) =>
      `<h2 style="font-size:15px;color:#6b7280">message ${i + 1} — ${m.length} / 4096 chars</h2>
<pre style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:14px;white-space:pre-wrap">${escapeHtml(m)}</pre>`,
  )
  .join("")}
<p><a href="/">← Dashboard</a></p></body>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }

        case path === "/diag/tune": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const id = url.searchParams.get("id") ?? "";
          const candidates = (url.searchParams.get("q") ?? "")
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean);
          if (!candidates.length) return json({ error: "pass ?q=a|b|c" }, 400);
          const source = SOURCE_BY_ID[id];
          return json({
            id,
            mustMention: source?.mustMention ?? [],
            results: await tuneQueries(candidates, source?.mustMention ?? []),
          });
        }

        case path === "/diag/feeds": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const candidates = (url.searchParams.get("u") ?? "")
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((u, i) => ({ id: `cand${i + 1}`, url: u }));
          if (!candidates.length) return json({ error: "pass ?u=url1|url2" }, 400);
          return json({ results: await tuneFeeds(candidates) });
        }

        case path === "/maintenance/unwrap-urls": {
          // One-off repair for rows stored before Bing redirect unwrapping
          // existed. Idempotent: a row already holding a direct link matches
          // nothing and is left alone.
          if (!admin) return json({ error: "unauthorised" }, 401);
          const { results } = await env.DB.prepare(
            `SELECT id, url FROM articles WHERE url LIKE '%bing.com/news/apiclick%' OR url LIKE '%bing.com/news/apiclick.aspx%'`,
          ).all<{ id: number; url: string }>();
          let fixed = 0;
          for (const row of results ?? []) {
            const next = unwrapBingUrl(row.url);
            if (next === row.url) continue;
            await env.DB.prepare(`UPDATE articles SET url = ? WHERE id = ?`).bind(next, row.id).run();
            fixed++;
          }
          return json({ scanned: (results ?? []).length, fixed });
        }

        case path === "/diag/sources": {
          // Dry run of the poll: fetch everything, report per source, store
          // nothing. This is the check that must pass before the cron can be
          // trusted to run unattended.
          if (!admin) return json({ error: "unauthorised" }, 401);
          const fetched = await fetchAllCloudSources({
            lookbackHours: Math.max(1, Number(url.searchParams.get("hours")) || lookback(env)),
            maxPerSource: num(env.MAX_ITEMS_PER_SOURCE, 12),
            retry429: true,
          });
          const counts = fetched.counts;
          const ids = Object.keys(counts);
          return json({
            total_sources: ids.length,
            working: ids.filter((id) => counts[id]! > 0).length,
            empty: ids.filter((id) => counts[id] === 0),
            failed: fetched.failed,
            articles: fetched.articles.length,
            ms: fetched.ms,
            counts,
            sample: fetched.articles.slice(0, 8).map((a) => `${a.sourceId}: ${a.title.slice(0, 70)}`),
          });
        }

        case path === "/diag/alt": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const domain = url.searchParams.get("domain") ?? "nbc.gov.kh";
          const results = await probeAlternatives(domain);
          return json({
            domain,
            anyUsable: results.some((r) => r.bytes > 500),
            results,
          });
        }

        case path === "/diag/google": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const domain = url.searchParams.get("domain") ?? "nbc.gov.kh";
          const results = await probeGoogle(domain);
          return json({
            domain,
            winner: winner(results),
            results,
          });
        }

        case path === "/probe": {
          // Diagnostic: fetch a URL from Cloudflare's own egress and report the
          // status. Needed because Google News 503s datacenter IPs, and we must
          // not assume any other source is reachable without checking.
          if (!admin) return json({ error: "unauthorised" }, 401);
          const target = url.searchParams.get("url");
          if (!target) return json({ error: "pass ?url=<absolute url>" }, 400);
          const started = Date.now();
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);
            const res = await fetch(target, {
              headers: { "User-Agent": "Khmer24BI/1.0 (+https://khmer24news.khmer24newskh.workers.dev)" },
              signal: controller.signal,
              redirect: "follow",
            });
            clearTimeout(timer);
            const body = await res.text();
            const looksFeed =
              /<rss[\s>]/i.test(body.slice(0, 2000)) || /<feed[\s>]/i.test(body.slice(0, 2000)) ||
              /<item[\s>]/i.test(body.slice(0, 4000)) || /<entry[\s>]/i.test(body.slice(0, 4000));
            const items =
              (body.match(/<item[\s>]/gi) ?? []).length || (body.match(/<entry[\s>]/gi) ?? []).length;
            const titles = [...body.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
              .map((m) => (m[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim())
              .filter((t) => t.length > 3)
              .slice(0, 6);
            return json({
              ok: res.ok,
              status: res.status,
              ms: Date.now() - started,
              bytes: body.length,
              looks_feed: looksFeed,
              items,
              titles,
              sample: body.slice(0, 160).replace(/\s+/g, " "),
            });
          } catch (err) {
            return json({
              ok: false, error: `${(err as Error).name}: ${(err as Error).message}`,
              ms: Date.now() - started,
            });
          }
        }

        case path === "/ingest": {
          // Push target for the local Python fetcher. See DISCOVERY-NOTES.md:
          // Google News blocks Cloudflare, so the Worker cannot poll.
          if (!admin) return json({ error: "unauthorised - pass ?key=ADMIN_TOKEN or X-Admin-Token" }, 401);
          let payload: { articles?: IngestEntry[] };
          try {
            payload = (await request.json()) as { articles?: IngestEntry[] };
          } catch {
            return json({ error: "body must be JSON: { \"articles\": [...] }" }, 400);
          }
          const articles = Array.isArray(payload.articles) ? payload.articles : [];
          if (articles.length === 0) return json({ error: "no articles in payload" }, 400);
          if (articles.length > 500) return json({ error: "too many articles (max 500 per push)" }, 400);

          const res = await ingestEntries(env.DB, articles, lookback(env));
          console.log(`ingest: received=${res.received} inserted=${res.inserted} dup=${res.duplicate} junk=${res.junk} old=${res.too_old}`);

          // Alert immediately on arrival so "every source update" means now,
          // not at the next cron tick. A failed send leaves the watermark alone.
          let alerts: { sent: number; error: string | null } | null = null;
          if (res.inserted > 0 && strFlag(env.STREAM_ALERTS, true)) {
            const a = await sendNewArticleAlerts(env, {
              perMessage: num(env.ALERT_BATCH_SIZE, DEFAULT_ALERT_BATCH_SIZE),
              maxPerTick: num(env.ALERT_MAX_PER_TICK, DEFAULT_ALERT_MAX_PER_TICK),
            });
            alerts = { sent: a.sentArticles, error: a.error };
            if (a.error) console.log(`ingest: alert send failed - ${a.error}`);
          }
          return json({ ...res, alerts });
        }

        case path === "/alerts": {
          // Send whatever is new since the last tick. Used by the frequent cron
          // and available for a manual trigger.
          if (!admin && !fromCron) return json({ error: "unauthorised" }, 401);
          const dryRun = url.searchParams.get("dry") === "1";
          const res = await sendNewArticleAlerts(env, {
            perMessage: num(env.ALERT_BATCH_SIZE, DEFAULT_ALERT_BATCH_SIZE),
            maxPerTick: num(env.ALERT_MAX_PER_TICK, DEFAULT_ALERT_MAX_PER_TICK),
            dryRun,
          });
          if (url.searchParams.get("json") === "1" || dryRun) return json(res);
          if (res.backfilled) {
            flashes.push({ kind: "info", text: `Alerts primed at id ${res.watermark}; nothing sent on the first run.` });
          } else if (res.sentArticles > 0) {
            flashes.push({ kind: "ok", text: `Alerts: ${res.sentArticles} article(s) in ${res.sentMessages} message(s).` });
          } else {
            flashes.push({ kind: "info", text: "Alerts: nothing new." });
          }
          if (res.error) flashes.push({ kind: "error", text: `Alert send failed - ${res.error}` });
          return redirect("/?flashes=" + encodeURIComponent(JSON.stringify(flashes)));
        }

        case path === "/alerts/reset": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const mark = await resetAlertWatermark(env);
          if (url.searchParams.get("json") === "1") return json({ mutedAt: mark });
          flashes.push({ kind: "info", text: `Alerts muted until the next new article (watermark = ${mark}).` });
          return redirect("/?flashes=" + encodeURIComponent(JSON.stringify(flashes)));
        }

        case path === "/alerts/preview": {
          // Shows exactly what the next alert tick would send, without sending.
          if (!admin) return json({ error: "unauthorised" }, 401);
          const rows = await pendingAlerts(env, num(env.ALERT_MAX_PER_TICK, DEFAULT_ALERT_MAX_PER_TICK));
          return json({
            pending: await countPendingAlerts(env.DB),
            messages: buildAlertMessages(rows, num(env.ALERT_BATCH_SIZE, DEFAULT_ALERT_BATCH_SIZE)),
          });
        }

        case path === "/api/articles": {
          if (!admin) return json({ error: "unauthorised - pass ?key=ADMIN_TOKEN" }, 401);
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours")) || lookback(env), 720));
          const rows = await getArticles(env.DB, { limit: 200, hours });
          return json(rows);
        }

        case path === "/ai-check": {
          // Diagnostic: confirms the Workers AI binding works and a model
          // answers. Pass ?model=@cf/... to test candidates without redeploying.
          if (!admin) return json({ error: "unauthorised" }, 401);
          const model = url.searchParams.get("model") || DEFAULT_AI_MODEL;
          const started = Date.now();
          try {
            const res = (await env.AI!.run(model, {
              messages: [
                { role: "system", content: "Reply with only the word: ready" },
                { role: "user", content: "ping" },
              ],
              max_tokens: 8,
            })) as { response?: string; usage?: Record<string, number> };
            return json({
              ok: true, model, ms: Date.now() - started,
              reply: (res.response ?? "").trim().slice(0, 80),
              usage: res.usage ?? null,
              analysis_enabled: (env.AI_ANALYSIS ?? "1") !== "0",
            });
          } catch (err) {
            return json({
              ok: false, model,
              error: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 240),
            }, 200);
          }
        }

        case path === "/telegram/hook": {
          // Telegram webhook. Secured with the secret token Telegram echoes back
          // in X-Telegram-Bot-Api-Secret-Token, so nobody else can drive the bot.
          if (request.method !== "POST") return json({ error: "POST only" }, 405);
          const expected = env.TELEGRAM_WEBHOOK_SECRET;
          if (!expected) {
            return json({ error: "webhook not configured: set TELEGRAM_WEBHOOK_SECRET, then call /telegram/setwebhook" }, 503);
          }
          const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
          if (!got || got.length !== expected.length || !timingSafeEqual(got, expected)) {
            return json({ error: "forbidden" }, 403);
          }

          let update: Record<string, unknown>;
          try {
            update = (await request.json()) as Record<string, unknown>;
          } catch {
            return json({ error: "bad json" }, 400);
          }

          const settingsUrl = `${url.protocol}//${url.host}/settings`;
          const defaultChat = env.TELEGRAM_CHAT_ID;

          const message = update.message as { text?: string; chat?: { id?: number } } | undefined;
          if (message?.text) {
            const cmd = message.text.trim().split(/\s+/)[0]!.toLowerCase();
            const to = String(message.chat?.id ?? defaultChat);
            if (cmd === "/status" || cmd === "/health" || cmd === "/st") {
              const r = await sendWithMenu(env, to, await buildStatus(env), { inline_keyboard: [] });
              return json({ handled: "status", result: r });
            }
            if (cmd === "/menu" || cmd === "/start" || cmd === "/settings") {
              const prefs = await loadPrefs(env.DB);
              const r = await sendWithMenu(env, to, menuCaption(prefs), buildKeyboardWithUrl(prefs, settingsUrl));
              return json({ handled: "menu", result: r });
            }
            if (cmd === "/brief" || cmd === "/send") {
              const r = await buildAndSendBrief(env);
              return json({ handled: "send", result: r });
            }
            // Help rather than silence. A command that quietly does nothing is
            // indistinguishable from a broken bot.
            if (cmd.startsWith("/")) {
              const prefs = await loadPrefs(env.DB);
              const help = [
                "\u{1F527} What I understand:",
                "",
                "/menu    - open the settings keyboard",
                "/status  - is it working, and when did things last run",
                "/brief   - send the business brief now",
                "",
                "Type /menu to choose which sections reach you.",
              ].join("\n");
              const r = await sendWithMenu(env, to, help, buildKeyboardWithUrl(prefs, settingsUrl));
              return json({ handled: "help", command: cmd, result: r });
            }
          }

          const cb = update.callback_query as
            | { data?: string; id?: string; message?: { message_id?: number; chat?: { id?: number } } }
            | undefined;
          if (cb?.data?.startsWith(MENU_PREFIX)) {
            const to = String(cb.message?.chat?.id ?? defaultChat);
            const mid = Number(cb.message?.message_id ?? 0);
            // Telegram spins the button for ~3s, so the tap is acknowledged
            // before anything slow happens.
            const answer = async (text?: string): Promise<void> => {
              if (!cb.id) return;
              try {
                await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    callback_query_id: cb.id,
                    ...(text ? { text: text.slice(0, 190) } : {}),
                  }),
                });
              } catch { /* the spin is cosmetic; never fail the tap over it */ }
            };
            const show = (text: string, kb: unknown) =>
              mid ? editMessageText(env, to, mid, text, kb) : Promise.resolve({ ok: true, detail: "no message id" });

            // Hide: strip the buttons, leave a note so the thread still explains itself.
            if (cb.data === CLOSE) {
              await answer();
              await show("Menu closed. Type /menu to open it again.", NO_KEYBOARD);
              return json({ handled: "close" });
            }

            // Browse: list every section so one can be opened on its own.
            if (cb.data === `${MENU_PREFIX}:browse`) {
              await answer();
              const prefs = await loadPrefs(env.DB);
              const r = await sendWithMenu(
                env, to,
                "\u{1F4CB} Which one do you want to see?\n\n" +
                  "This shows what is in a section right now. It does not change " +
                  "your daily brief - use the menu for that.",
                buildSectionPicker(prefs),
              );
              return json({ handled: "browse", result: r });
            }

            // Open one section's content. This is what the main-menu buttons do.
            if (cb.data.startsWith(SECTION_PREFIX)) {
              const key = cb.data.slice(SECTION_PREFIX.length) as Section;
              await answer("Loading...");
              try {
                const prefs = await loadPrefs(env.DB);
                const stored = await getArticles(env.DB, { limit: 200, hours: prefs.hours });
                const rows = filterRows(stored, prefs);
                const fx = await fetchFxRates();
                // No applyPrefs: a section you switched off should still open.
                const report = buildIntelReport(rows, fx, []);
                const inBrief = prefs.sections.includes(key);
                const r = await sendWithMenu(
                  env, to,
                  renderSectionView(report, key, prefs.sections.length, inBrief),
                  buildSectionFooter(key, inBrief),
                );
                return json({ handled: "section", section: key, in_brief: inBrief, result: r });
              } catch (err) {
                const prefs = await loadPrefs(env.DB);
                const r = await sendWithMenu(
                  env, to,
                  `Could not load that section: ${(err as Error).message}`,
                  buildSectionFooter(key, prefs.sections.includes(key)),
                );
                return json({ handled: "section", section: key, error: (err as Error).message, result: r });
              }
            }

            // Add or remove the section from the daily brief, then show it
            // again with the button state updated.
            if (cb.data.startsWith(`${MENU_PREFIX}:toggle:`)) {
              const key = cb.data.slice(`${MENU_PREFIX}:toggle:`.length) as Section;
              const { prefs, note } = await handleToggle(env.DB, `kb24:toggle:${key}`);
              await answer(note || undefined);
              try {
                const stored = await getArticles(env.DB, { limit: 200, hours: prefs.hours });
                const rows = filterRows(stored, prefs);
                const fx = await fetchFxRates();
                const report = buildIntelReport(rows, fx, []);
                const inBrief = prefs.sections.includes(key);
                const text = [note, "", renderSectionView(report, key, prefs.sections.length, inBrief)]
                  .filter((l) => l !== undefined)
                  .join("\n");
                const r = await sendWithMenu(env, to, text, buildSectionFooter(key, inBrief));
                return json({ handled: "toggled", section: key, in_brief: inBrief, note, result: r });
              } catch (err) {
                return json({ handled: "toggled", section: key, note, error: (err as Error).message });
              }
            }

            // Back to the settings keyboard.
            if (cb.data === `${MENU_PREFIX}:back`) {
              await answer();
              const prefs = await loadPrefs(env.DB);
              const r = await sendWithMenu(env, to, menuCaption(prefs), buildKeyboardWithUrl(prefs, settingsUrl));
              return json({ handled: "back", result: r });
            }

            // Status: a fresh message rather than an edit, because a status
            // report you want to keep should not overwrite the menu you tap.
            if (cb.data === `${MENU_PREFIX}:status`) {
              await answer("Checking...");
              const r = await sendWithMenu(env, to, await buildStatus(env), { inline_keyboard: [] });
              return json({ handled: "status", result: r });
            }

            // Send now: strip the buttons, report progress, then confirm.
            if (cb.data === SEND_NOW) {
              await answer("Building your brief...");
              await show("Building your brief from your current settings...", NO_KEYBOARD);
              const r = await buildAndSendBrief(env);
              const summary = r.error
                ? `\u{1F6AB} Could not send: ${r.error}`
                : `\u{1F4E4} Sent ${r.messages} message(s) with ${r.opportunities} opportunity(ies).`;
              await show(summary, NO_KEYBOARD);
              return json({ handled: "send", result: r });
            }

            // handleToggle persists on its own, so a tap is atomic.
            const { prefs, note } = await handleToggle(env.DB, cb.data);
            await answer(note || undefined);
            const caption = note ? `${note}\n\n${menuCaption(prefs)}` : menuCaption(prefs);
            const edit = await show(caption, buildKeyboardWithUrl(prefs, settingsUrl));
            return json({ handled: "callback", data: cb.data, edited: edit.ok, note });
          }
          return json({ handled: "ignored" });
        }

        case path === "/telegram/setwebhook": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          const secret = env.TELEGRAM_WEBHOOK_SECRET;
          if (!secret) return json({ error: "set TELEGRAM_WEBHOOK_SECRET as a secret first" }, 400);
          const target = url.searchParams.get("url") ?? `${url.protocol}//${url.host}/telegram/hook`;
          return json(await setWebhook(env, target, secret));
        }

        case path === "/telegram/webhook-info": {
          if (!admin) return json({ error: "unauthorised" }, 401);
          return json(await webhookInfo(env));
        }

        case path === "/settings": {
          if (request.method === "GET") {
            const prefs = await loadPrefs(env.DB);
            const counts = await sectionCounts(env.DB);
            return new Response(
              renderSettings(prefs, { counts, basePath: "", saved: url.searchParams.get("saved") === "1" }),
              { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
            );
          }
          if (!admin) return json({ error: "unauthorised - pass ?key=ADMIN_TOKEN" }, 401);
          const form = await request.formData();
          const list = (k: string) => form.getAll(k).map((v) => String(v));
          const next: Prefs = {
            sections: list("sections") as Prefs["sections"],
            sources: list("sources"),
            categories: list("categories"),
            hours: Number(form.get("hours") ?? DEFAULT_PREFS.hours) || DEFAULT_PREFS.hours,
            minUrgency: String(form.get("min_urgency") ?? "watch") as Prefs["minUrgency"],
            ai: form.get("ai") !== null,
            autoSend: form.get("auto_send") !== null,
            alertStyle: String(form.get("alert_style") ?? "breaking") as Prefs["alertStyle"],
            breakingOnly: form.get("breaking_only") !== null,
          };
          if (next.sections.length === 0) {
            return new Response(
              renderSettings(await loadPrefs(env.DB), {
                counts: await sectionCounts(env.DB), basePath: "",
                error: "Pick at least one section.",
              }),
              { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
            );
          }
          await savePrefs(env.DB, next);
          return redirect("/settings?saved=1");
        }

        case path === "/intel": {
          // The 8-section Business Intelligence report, built from D1 + live FX.
          // The HTML is safe to serve publicly; only ?telegram=1 sends, and that
          // requires the admin key.
          const prefs = await loadPrefs(env.DB);
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours")) || prefs.hours, 720));
          const all = await getArticles(env.DB, { limit: 200, hours });
          // Filter on the data first, then on the rendered sections.
          const rows = filterRows(all, prefs);
          const fx = await fetchFxRates();
          let report = buildIntelReport(rows, fx, coverageWarnings());

          // AI enhances; it never blocks. Any failure keeps the rule report.
          let ai: AiAnalysis | null = null;
          if (prefs.ai && url.searchParams.get("ai") !== "0") {
            const override = url.searchParams.get("model");
            ai = await runAnalyst(override ? { ...env, AI_MODEL: override } : env, rows, fx);
            applyAnalysis(report, ai);
          }
          report = applyPrefs(report, prefs);

          if (url.searchParams.get("json") === "1") return json({ ...report, ai });
          if (url.searchParams.get("telegram") === "1") {
            if (!admin) return json({ error: "unauthorised - pass ?key=ADMIN_TOKEN" }, 401);
            const msgs = renderIntelMessages(report);
            const results = [];
            for (const t of msgs) {
              const r = await sendTelegram(env, t);
              results.push({ ok: r.ok, detail: r.detail });
              if (!r.ok) break;
            }
            return json({ sent: results, ai: ai ? { used: ai.used, reason: ai.reason, tokens: ai.tokensIn + ai.tokensOut } : null });
          }
          return new Response(renderIntel(report), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }

        case path === "/collect-cloud": {
          // Fetch the sources the Worker can reach itself (everything except
          // Google News, which 503s Cloudflare).
          if (!admin) return json({ error: "unauthorised" }, 401);
          const res = await fetchAllCloudSources({
            lookbackHours: lookback(env),
            maxPerSource: num(env.MAX_ITEMS_PER_SOURCE, 12),
            retry429: true,
          });
          const ingested = await ingestEntries(
            env.DB,
            res.articles.map((a) => ({
              source: a.sourceId,
              title: a.title,
              link: a.url,
              published: a.published,
              age_hours: a.ageHours,
              summary: a.summary,
            })),
            lookback(env),
          );
          let alerts: { sent: number; error: string | null } | null = null;
          if (ingested.inserted > 0 && strFlag(env.STREAM_ALERTS, true)) {
            const a = await sendNewArticleAlerts(env, {
              perMessage: num(env.ALERT_BATCH_SIZE, DEFAULT_ALERT_BATCH_SIZE),
              maxPerTick: num(env.ALERT_MAX_PER_TICK, DEFAULT_ALERT_MAX_PER_TICK),
            });
            alerts = { sent: a.sentArticles, error: a.error };
          }
          return json({
            sources_ok: res.ok,
            sources_failed: res.failed,
            fetched: res.articles.length,
            ms: res.ms,
            ...ingested,
            alerts,
          });
        }

        case path === "/": {
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours")) || lookback(env), 720));
          const category = url.searchParams.get("category") ?? "all";
          const articles = await getArticles(env.DB, { limit: 100, hours, category });
          const counts = await categoryCounts(env.DB, hours);
          const totals: Record<string, number> = Object.fromEntries(counts.map((c) => [c.category, c.n]));

          // Flash messages survive a redirect as JSON in the query string.
          let parsed: Flash[] = [];
          const raw = url.searchParams.get("flashes");
          if (raw) {
            try {
              const decoded = JSON.parse(raw);
              if (Array.isArray(decoded)) {
                parsed = decoded
                  .filter((f) => f && typeof f.text === "string")
                  .slice(0, 10)
                  .map((f) => ({ kind: f.kind === "ok" || f.kind === "error" ? f.kind : "info", text: String(f.text) }));
              }
            } catch {
              /* ignore malformed input */
            }
          }

          return new Response(
            renderDashboard({
              articles,
              counts,
              totals,
              hours,
              category,
              flashes: parsed,
              telegramReady: telegramConfigured(env),
              isAdmin: admin,
              adminKey: url.searchParams.get("key") ?? "",
              basePath: "",
            }),
            { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
          );
        }

        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (url.searchParams.get("json") === "1") return json({ error: message }, 500);
      // Deliberately NOT a redirect back to "/": if the failure is in rendering
      // the dashboard, redirecting there throws again and the browser spins in a
      // 302 loop. An honest error page cannot loop.
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Error</title>` +
          `<body style="font-family:Segoe UI,Arial;max-width:820px;margin:48px auto;padding:0 16px">` +
          `<h1>Server error</h1><pre style="background:#fef2f2;border:1px solid #fca5a5;` +
          `border-radius:8px;padding:14px;white-space:pre-wrap">${escapeHtml(message)}</pre>` +
          `<p>If this is the first run, has the D1 database been created and its id set in ` +
          `<code>wrangler.toml</code>?</p><p><a href="/">← Dashboard</a></p></body>`,
        { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
  },

  /**
   * Cron Triggers. Two schedules land here, told apart by the cron expression:
   *   - the frequent one (e.g. every 5 min) collects and sends new-article
   *     alerts, so news reaches you as each source publishes it;
   *   - the 00:30 UTC one also sends the daily digest.
   *
   * Runs whether or not any machine is switched on, which is the whole point of
   * moving off Task Scheduler.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchemaOnce(env.DB);
          const cron = event.cron ?? "";
          const isDailyRun = /^\d+ 0 \* \* \*$/.test(cron.trim());
          const streamAlerts = strFlag(env.STREAM_ALERTS, true);
          const dailyDigest = strFlag(env.DAILY_DIGEST, true);

          // Recorded first, before anything that can fail, so a crash later in
          // the tick still reads as "it ran" rather than "it never ran".
          await setCronHeartbeat(env.DB, cron || "(unnamed)");

          if (isDailyRun && !dailyDigest && !streamAlerts) {
            console.log("cron: both STREAM_ALERTS and DAILY_DIGEST are off - nothing to do");
            return;
          }

          // Each phase is isolated. They used to share one try/catch, so a failure
          // while polling or alerting silently prevented the daily brief - the one
          // thing this system exists to produce. A phase that fails now records
          // why, and the remaining phases still run.
          const recordError = async (phase: string, err: unknown): Promise<void> => {
            const message = (err as Error)?.message ?? String(err);
            const detail = `${phase}: ${(err as Error)?.name ?? "Error"}: ${message}`.slice(0, 300);
            console.log(`cron[${cron}] ${detail}`);
            try {
              await env.DB.prepare(
                `INSERT INTO meta(key, value) VALUES('cron:last_error', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
              ).bind(detail).run();
            } catch { /* if even this fails there is nothing more to do */ }
          };

          // Discovery. "poll" is the mode that needs nothing local: the Worker
          // fetches every source itself. "push" is the legacy path where articles
          // arrive via POST /ingest, kept as a fallback.
          const discovery = (env.DISCOVERY_MODE ?? "poll").trim().toLowerCase();
          if (discovery === "push") {
            console.log(`cron[${cron}] discovery=push - articles come from /ingest, not polled here`);
          } else {
            try {
              const fetched = await fetchAllCloudSources({
                lookbackHours: lookback(env),
                maxPerSource: num(env.MAX_ITEMS_PER_SOURCE, 12),
                retry429: true,
              });
              const ingested = await ingestEntries(
                env.DB,
                fetched.articles.map((a) => ({
                  source: a.sourceId,
                  title: a.title,
                  link: a.url,
                  published: a.published,
                  age_hours: a.ageHours,
                  summary: a.summary,
                })),
                lookback(env),
              );
              console.log(
                `cron[${cron}] poll: ${fetched.articles.length} article(s) from ` +
                  `${fetched.ok} source(s), ${ingested.inserted} new, ${fetched.ms}ms`,
              );
              for (const f of fetched.failed) {
                console.log(`cron[${cron}] poll fail ${f.sourceId}: ${f.reason}`);
              }
              const empty = Object.entries(fetched.counts).filter(([, n]) => n === 0);
              if (empty.length) {
                console.log(`cron[${cron}] poll empty: ${empty.map(([id]) => id).join(", ")}`);
              }
            } catch (err) {
              await recordError("poll failed", err);
            }
          }

          // Stream alerts on every tick, whatever the discovery mode.
          if (streamAlerts) {
            try {
              const alerts = await sendNewArticleAlerts(env, {
                perMessage: num(env.ALERT_BATCH_SIZE, DEFAULT_ALERT_BATCH_SIZE),
                maxPerTick: num(env.ALERT_MAX_PER_TICK, DEFAULT_ALERT_MAX_PER_TICK),
              });
              if (alerts.backfilled) {
                console.log(`cron[${cron}] alerts primed at id ${alerts.watermark} (nothing sent)`);
              } else if (alerts.sentArticles > 0) {
                console.log(
                  `cron[${cron}] alerts: ${alerts.sentArticles} article(s) in ` +
                    `${alerts.sentMessages} message(s), ${alerts.pending} still pending`,
                );
              }
              if (alerts.error) console.log(`cron[${cron}] alerts FAILED: ${alerts.error}`);
            } catch (err) {
              await recordError("alerts failed", err);
            }
          }

          // The 07:30 brief.
          //
          // Also runs on an ordinary tick if the daily one has not succeeded for
          // a while. A missed brief used to be lost outright: the tick either
          // happened or it did not, and nothing retried. Catch-up turns a
          // failure into a delay instead of a silence.
          const dailyDue = await dailyBriefOverdue(env.DB);
          if ((isDailyRun && dailyDigest) || (dailyDue.overdue && dailyDigest)) {
            const why = isDailyRun ? "scheduled" : "catch-up";
            const r = await sendDailyBrief(env, `cron[${cron}] ${why}`);
            console.log(
              `cron[${cron}] brief (${why}): ${r.sent}/${r.messages} message(s) sent, ` +
                `${r.opportunities} opportunities - ${r.detail}`,
            );
            if (isDailyRun && !dailyDigest) {
              console.log(`cron[${cron}] DAILY_DIGEST is off - brief suppressed`);
            }
            if (dailyDue.overdue && !isDailyRun) {
              console.log(
                `cron[${cron}] brief was overdue (${dailyDue.hoursSinceOk}h since the last success) - caught up`,
              );
            }
          }

          const days = Number(env.PURGE_AFTER_DAYS ?? 0);
          if (days > 0 && isDailyRun) {
            const removed = await purgeOlderThan(env.DB, days);
            console.log(`cron[${cron}] purge: removed ${removed} rows older than ${days} days`);
          }
          console.log(`cron[${cron}] done`);
        } catch (err) {
          console.log(`cron[${event.cron}] ERROR: ${(err as Error).name}: ${(err as Error).message}`);
        }
      })(),
    );
  },
};

/** Constant-time compare for equal-length strings. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function strFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
