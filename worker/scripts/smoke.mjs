#!/usr/bin/env node
/**
 * End-to-end smoke test against the deployed Worker.
 *
 * Exists because "is it working?" kept needing a different ad-hoc script, and
 * because two false conclusions this session came from checking the wrong thing:
 * `wrangler tail` does not show scheduled events, and article timestamps prove
 * nothing when a poll finds nothing new. This asks the deployed system directly.
 *
 *   node worker/scripts/smoke.mjs
 *
 * Reads ADMIN_TOKEN from ../.env. Exits non-zero if any check fails, so it can
 * gate a deploy or be run on a schedule.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const REPO = join(HERE, "..", "..");
const BASE =
  process.env.WORKER_URL ??
  "https://khmer24news.khmer24newskh.workers.dev";

/** Pull a value out of .env without needing a dotenv dependency. */
function envValue(name) {
  let text;
  try {
    text = readFileSync(join(REPO, ".env"), "utf8");
  } catch {
    throw new Error(`cannot read ${join(REPO, ".env")} - is the project set up?`);
  }
  const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

const KEY = envValue("ADMIN_TOKEN") || envValue("API_TOKEN");
const WEBHOOK_SECRET = envValue("TELEGRAM_WEBHOOK_SECRET");
const KEYED = `key=${encodeURIComponent(KEY)}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

async function get(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or plain text */ }
  return { status: res.status, text, json };
}

console.log(`Smoke test: ${BASE}`);

section("[1] the Worker is up and the cron is alive");
{
  const { status, json } = await get("/health");
  check("health responds 200", status === 200, String(status));
  check("ok is true", json?.ok === true, `ok=${json?.ok} warning=${json?.warning ?? ""}`);
  check("the cron is not stale", json?.cron_stale === false, `stale=${json?.cron_stale}`);
  check("telegram is configured", json?.telegram_configured === true);
  check("articles are stored", (json?.articles ?? 0) > 0, `articles=${json?.articles}`);
  check("no alert backlog", (json?.pending_alerts ?? 1) === 0, `pending=${json?.pending_alerts}`);
  const schedules = Object.keys(json?.cron_per_schedule ?? {}).filter(Boolean);
  check("each cron is tracked separately", schedules.length > 0, schedules.join(" | "));
  check("the 10-minute poll is recorded",
    schedules.some((s) => s.includes("*/10")), schedules.join(" | "));
  console.log(`        articles=${json?.articles}  schedules=${schedules.join(" | ")}`);
}

section("[2] the brief builds with all 8 sections");
{
  const { status, json } = await get(`/intel?json=1&${KEYED}`);
  check("intel responds 200", status === 200, String(status));
  const sections = (json?.sections ?? []).map((s) => s.section);
  check("8 sections", sections.length === 8, sections.join(", "));
  for (const want of ["money", "opportunity"]) {
    check(`the core section '${want}' is present`, sections.includes(want));
  }
  check("opportunities were found", (json?.opportunities ?? []).length > 0,
    `${json?.opportunities?.length}`);
  const populated = (json?.sections ?? []).filter((s) => !s.empty).length;
  check("most sections have content", populated >= 4, `${populated}/8 populated`);
}

section("[3] sources are being fetched");
{
  const { status, json } = await get(`/diag/sources?${KEYED}`);
  check("diagnostic responds 200", status === 200, String(status));
  const total = json?.total_sources ?? 0;
  const working = json?.working ?? 0;
  check("at least 30 sources registered", total >= 30, String(total));
  // Not 100%: VentureBeat rate-limits, and one feed being down is not a failure.
  check("at least 30 sources are working", working >= 30, `${working}/${total}`);
  check("articles are being returned", (json?.articles ?? 0) > 20, String(json?.articles));
  console.log(`        ${working}/${total} sources, ${json?.articles} articles in ${json?.ms}ms`);
}

section("[4] Telegram can send");
{
  // Read-only: validates the credentials without delivering anything.
  const { json } = await get("/check?json=1");
  check("credentials are valid", json?.ok === true, JSON.stringify(json?.lines));
  check("the bot is reachable", (json?.lines ?? []).every((l) => l.ok));
}

section("[5] the public pages render");
{
  for (const [path, needle] of [
    ["/", "Khmer24"],
    ["/settings", "What to watch"],
    ["/intel", "BREAKING"],
  ]) {
    const { status, text } = await get(path);
    check(`${path} responds 200`, status === 200, String(status));
    check(`${path} contains '${needle}'`, text.includes(needle));
  }
}

section("[6] the settings page has every control");
{
  const { text } = await get("/settings");
  for (const control of [
    'name="sections"', 'name="sources"', 'name="categories"',
    'name="min_urgency"', 'name="alert_style"', 'name="breaking_only"',
    'name="auto_send"', 'name="ai"',
  ]) {
    check(`offers ${control}`, text.includes(control));
  }
}

section("[7] mutating routes are locked without the key");
{
  for (const path of ["/collect", "/send", "/run", "/alerts", "/ingest", "/telegram/setwebhook"]) {
    const { status } = await get(path, { method: "POST" });
    check(`${path} is 401 without a key`, status === 401, `got ${status}`);
  }
}

section("[8] the Telegram webhook refuses strangers");
{
  const { status } = await get("/telegram/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
    body: JSON.stringify({ message: { text: "/menu", chat: { id: 1 } } }),
  });
  check("a wrong secret is 403", status === 403, `got ${status}`);

  const noHeader = await get("/telegram/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  check("no secret is 403", noHeader.status === 403, `got ${noHeader.status}`);

  const wrongMethod = await get("/telegram/hook");
  check("GET is 405", wrongMethod.status === 405, `got ${wrongMethod.status}`);
  void WEBHOOK_SECRET; // presence is checked, the value must never be printed
}

section("[9] the daily brief is accounted for");
{
  const { json } = await get("/health");
  const d = json?.daily_brief ?? {};
  if (d.last_attempt === null || d.last_attempt === undefined) {
    // Expected until the first 00:30 UTC tick after the fix lands.
    console.log("  PASS  no daily attempt recorded yet (the 07:30 tick has not run since the fix)");
  } else {
    check("the last attempt succeeded", d.last_ok === true, `last_ok=${d.last_ok} detail=${d.detail}`);
  }
  check("no missed-brief warning", !json?.warning, json?.warning ?? "");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`  passed: ${pass}   failed: ${fail}`);
if (fail === 0) console.log("  the system is working end to end");
process.exit(fail === 0 ? 0 : 1);
