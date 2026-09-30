/**
 * The `/status` message: is this thing actually working?
 *
 * Added after a morning where the daily brief silently did not arrive and the
 * only way to find out was to open a log. The most common question about an
 * automated system is "is it running", and it belongs in the chat, one tap away,
 * not in a browser.
 */
import { cronHealth } from "./db.ts";
import { countAll, countPendingAlerts } from "./db.ts";
import type { Env } from "./env.ts";
import { telegramConfigured } from "./telegram.ts";
import { loadPrefs } from "./prefs.ts";

function ago(minutes: number | null): string {
  if (minutes === null) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** One line per fact, with a verdict at the top that needs no interpretation. */
export async function buildStatus(env: Env): Promise<string> {
  const [health, articles, pending, prefs] = await Promise.all([
    cronHealth(env.DB),
    countAll(env.DB),
    countPendingAlerts(env.DB),
    loadPrefs(env.DB),
  ]);

  const schedules = Object.entries(health.perCron);
  const poll = schedules.find(([expr]) => expr.includes("*/10"));
  const daily = schedules.find(([expr]) => !expr.includes("*/10"));

  const problems: string[] = [];
  if (health.stale) problems.push("the 10-minute poll is not running");
  if (!telegramConfigured(env)) problems.push("Telegram is not configured");
  if (health.daily.lastAttempt !== null && health.daily.ok === false) {
    problems.push(`the last brief failed: ${health.daily.detail}`);
  }
  if (health.daily.hoursSinceOk !== null && health.daily.hoursSinceOk > 30) {
    problems.push(`no brief for ${health.daily.hoursSinceOk} h`);
  }
  if (health.lastError) problems.push(`last error - ${health.lastError}`);

  const verdict = problems.length === 0
    ? "\u{2705} All working"
    : `\u{274C} ${problems.length} problem(s)`;

  const lines = [
    `\u{1F4CA} Khmer24 status`,
    verdict,
    "",
    `News poll    : ${poll ? ago(poll[1].minutesAgo) : "never seen"}`,
    `Daily brief  : ${daily ? ago(daily[1].minutesAgo) : "not yet recorded"}` +
      (health.daily.lastAttempt === null
        ? ""
        : `  (last send ${ago(health.daily.hoursSinceOk === null ? null : health.daily.hoursSinceOk * 60)})`),
    `Articles     : ${articles}`,
    `Alert queue  : ${pending}${pending > 0 ? "  (a tick will drain it)" : ""}`,
    `Your brief   : ${prefs.sections.length} sections, ${prefs.minUrgency} urgency, AI ${prefs.ai ? "on" : "off"}`,
    `Auto-send    : ${prefs.autoSend ? "on (07:30)" : "OFF"}`,
  ];

  if (health.lastError) lines.push("", `Last error: ${health.lastError}`);
  if (health.daily.lastAttempt !== null && health.daily.ok === false) {
    lines.push("", `Last brief: ${health.daily.detail}`);
  }
  for (const p of problems) lines.push(`  \u{2022} ${p}`);

  return lines.join("\n");
}

/** A one-line verdict for when a full status is too much. */
export async function statusVerdict(env: Env): Promise<string> {
  const health = await cronHealth(env.DB);
  if (health.stale) return "\u{274C} the news poll is not running";
  if (health.daily.hoursSinceOk !== null && health.daily.hoursSinceOk > 30) {
    return `\u{274C} no daily brief for ${health.daily.hoursSinceOk} h`;
  }
  return "\u{2705} working";
}
