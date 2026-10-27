/**
 * Tests for the Manus integration.
 *
 * No network and no credits: global `fetch` is replaced with a stub, so these
 * assert the exact request the Worker would send and the exact handling of each
 * documented response. The API shapes come from https://open.manus.ai/docs/v2.
 */
import {
  MANUS_PROFILES, awaitTask, extractError, extractResultText, getTask, listMessages,
  manusConfigured, pollTask, startTask,
} from "../src/manus.ts";
import { MANUS_INSTRUCTION, buildManusPrompt, fitForTelegram } from "../src/manusbrief.ts";
import { buildRootMenu, MENUS_FOR_TESTS, handleToggle } from "../src/telegrammenu.ts";
import { DEFAULT_PREFS } from "../src/prefs.ts";
import { MANUS_PROFILE_HELP_FOR_TESTS, renderSettings } from "../src/settingshtml.ts";
import { SECTION_META } from "../src/registry.ts";
import type { Article } from "../src/db.ts";
import type { FxRates } from "../src/market.ts";
import type { Env } from "../src/env.ts";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` - ${d}` : ""}`); }
};

const ENV = { MANUS_API_KEY: "test-key-not-real", MANUS_API_URL: "https://api.manus.ai" } as Env;

// ---------------------------------------------------------------- fetch stub
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
const calls: Call[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  const raw = (init?.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  calls.push({ url, method: init?.method ?? "GET", headers, body });
  const r = nextResponse;
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const reply = (status: number, body: unknown) => { nextResponse = { status, body }; };
const lastCall = () => calls[calls.length - 1]!;

const article = (over: Partial<Article> = {}): Article => ({
  id: 1, title: "Cambodia solar plant approved", title_hash: "h", url: "https://e.com/a",
  google_url: "", source: "AKP", tier: 1, published: new Date().toISOString(), age_hours: 2,
  category: "Investment", score: 60, summary: "", signals: "investment",
  opportunity: "O", action: "A", created_at: new Date().toISOString(), ...over,
} as Article);

const FX = { base: "USD", fetchedAt: new Date().toISOString(), provider: "t",
  perUsd: { KHR: 4048, THB: 33, CNY: 6.7, VND: 25900, EUR: 0.88, JPY: 157 } } as FxRates;

// ---------------------------------------------------------------- 1. config
console.log("[1] configuration is explicit");
check("no key means not configured",
  !manusConfigured({} as Env));
check("a key means configured", manusConfigured(ENV));
check("MANUS_ENABLED=0 is a master off switch",
  !manusConfigured({ ...ENV, MANUS_ENABLED: "0" } as Env));
check("MANUS_ENABLED=false also switches off",
  !manusConfigured({ ...ENV, MANUS_ENABLED: "false" } as Env));
check("MANUS_ENABLED=1 is on", manusConfigured({ ...ENV, MANUS_ENABLED: "1" } as Env));

// ---------------------------------------------------------------- 2. start
console.log("\n[2] starting a task");
calls.length = 0;
reply(200, {
  ok: true, request_id: "req_1", task_id: "abc123", task_title: "Khmer24 brief",
  task_url: "https://manus.im/app/abc123", share_visibility: "private",
});
const created = await startTask(ENV, "analyse these signals", { profile: "max", locale: "en" });
check("reports ok", created.ok, created.error ?? "");
check("carries the task id", created.taskId === "abc123");
check("carries the task url", created.taskUrl === "https://manus.im/app/abc123");
check("posts to /v2/task.create", lastCall().url.endsWith("/v2/task.create"), lastCall().url);
check("uses POST", lastCall().method === "POST");
check("sends the key in x-manus-api-key",
  lastCall().headers["x-manus-api-key"] === "test-key-not-real");
check("does NOT send Authorization as well",
  lastCall().headers["authorization"] === undefined,
  "the API rejects both headers together");
const sentBody = lastCall().body as { message?: { content?: string }; agent_profile?: string };
check("wraps the prompt in message.content", sentBody.message?.content === "analyse these signals");
check("passes the agent profile", sentBody.agent_profile === "max");
check("runs non-interactively so it cannot stall on a question",
  (sentBody as { interactive_mode?: boolean }).interactive_mode === false);

console.log("\n[3] refusing to spend credits on nothing");
calls.length = 0;
const empty = await startTask(ENV, "   ");
check("empty prompt rejected", !empty.ok);
check("and sends no request", calls.length === 0, `${calls.length} call(s)`);
const noKey = await startTask({} as Env, "hello");
check("no key rejected before any request", !noKey.ok && calls.length === 0);

console.log("\n[4] an API error is reported, not swallowed");
reply(401, { ok: false, request_id: "req_2", error: { code: "unauthenticated", message: "Invalid or missing API key" } });
const unauth = await startTask(ENV, "hello");
check("not ok", !unauth.ok);
check("mentions the API's own code", (unauth.error ?? "").includes("unauthenticated"), unauth.error ?? "");
check("mentions the message", (unauth.error ?? "").includes("Invalid or missing API key"));
check("mentions the request id for support", (unauth.error ?? "").includes("req_2"));

reply(200, { ok: false, error: { message: "no task_id in the response" } });
const noId = await startTask(ENV, "hello");
check("ok:false in a 200 body is still a failure", !noId.ok);
check("and says why", (noId.error ?? "").includes("no task_id"));

// ---------------------------------------------------------------- 5. detail
console.log("\n[5] reading task status");
calls.length = 0;
reply(200, { ok: true, task: { id: "abc123", status: "running", title: "Khmer24 brief" } });
const detail = await getTask(ENV, "abc123");
check("returns the task", detail.task?.status === "running");
check("calls task.detail", lastCall().url.includes("/v2/task.detail"));
check("passes task_id as a query parameter", lastCall().url.includes("task_id=abc123"));
check("URL-encodes the id",
  (await (async () => { await getTask(ENV, "a b"); return lastCall().url; })()).includes("task_id=a%20b"));

reply(404, { ok: false, error: { code: "not_found", message: "task not found" } });
const missing = await getTask(ENV, "nope");
check("a missing task is an error, not an empty task", missing.task === null && Boolean(missing.error));

// ---------------------------------------------------------------- 6. text
console.log("\n[6] picking the answer out of the log");
const progressOnly = [
  { id: "1", type: "assistant_message", assistant_message: { content: "Opening the browser...", delivery_kind: "progress" } },
];
check("progress alone is still text", extractResultText(progressOnly) === "Opening the browser...");

const withResult = [
  { id: "1", type: "assistant_message", assistant_message: { content: "Working on it", delivery_kind: "progress" } },
  { id: "2", type: "assistant_message", assistant_message: { content: "WHAT MATTERS\n..." , delivery_kind: "result" } },
  { id: "3", type: "assistant_message", assistant_message: { content: "trailing chatter", delivery_kind: "progress" } },
];
check("prefers the message marked result", extractResultText(withResult).startsWith("WHAT MATTERS"));

const noMarker = [
  { id: "1", type: "assistant_message", assistant_message: { content: "first" } },
  { id: "2", type: "assistant_message", assistant_message: { content: "final answer" } },
];
check("falls back to the last unmarked message", extractResultText(noMarker) === "final answer");
check("ignores user messages and status updates", extractResultText([
  { id: "1", type: "user_message", user_message: { content: "do it" } },
  { id: "2", type: "status_update", status_update: { brief: "thinking" } },
]) === "");
check("ignores blank assistant text", extractResultText([
  { id: "1", type: "assistant_message", assistant_message: { content: "   " } },
]) === "");

console.log("\n[7] agent errors surface");
check("an error_message is found", extractError([
  { id: "1", type: "error_message", error_message: { content: "credit limit reached" } },
]) === "credit limit reached");
check("the newest error wins", extractError([
  { id: "1", type: "error_message", error_message: { content: "old" } },
  { id: "2", type: "error_message", error_message: { content: "new" } },
]) === "new");
check("no error returns null", extractError([{ id: "1", type: "assistant_message" }]) === null);

// ---------------------------------------------------------------- 8. poll
console.log("\n[8] polling a task");
calls.length = 0;
reply(200, {
  ok: true,
  task: { id: "abc123", status: "stopped", title: "done", task_url: "https://manus.im/app/abc123" },
});
const snap = await pollTask(ENV, "abc123");
check("reads status", snap.task?.status === "stopped");
check("listMessages is called too", calls.some((c) => c.url.includes("/v2/task.listMessages")));
check("requests oldest-first so the result is last",
  lastCall().url.includes("order=asc"), lastCall().url);

console.log("\n[8b] the message log endpoint");
calls.length = 0;
reply(200, { ok: true, messages: [{ id: "m1", type: "assistant_message", assistant_message: { content: "hi" } }] });
const log = await listMessages(ENV, "abc123");
check("returns the messages", log.messages.length === 1 && log.error === null);
check("calls task.listMessages", lastCall().url.includes("/v2/task.listMessages"));
check("passes the task id", lastCall().url.includes("task_id=abc123"));
check("caps the limit at 200 so one call cannot be huge",
  (await (async () => { await listMessages(ENV, "abc123", { limit: 9999 }); return lastCall().url; })()).includes("limit=200"));
check("never asks for zero messages",
  (await (async () => { await listMessages(ENV, "abc123", { limit: 0 }); return lastCall().url; })()).includes("limit=1"));

reply(200, { ok: false, error: { message: "task is deleted" } });
const refused = await listMessages(ENV, "abc123");
check("ok:false is an error, not an empty log", refused.error === "task is deleted" && refused.messages.length === 0);

// ---------------------------------------------------------------- 9. wait
console.log("\n[9] waiting is bounded, and says when it ran out");
let clock = 0;
const fakeNow = () => clock;
const fakeSleep = async (ms: number) => { clock += ms; };
reply(200, { ok: true, task: { id: "abc123", status: "running" } });
const stillRunning = await awaitTask(ENV, "abc123", {
  maxWaitMs: 6_000, intervalMs: 2_000, now: fakeNow, sleep: fakeSleep,
});
check("a running task is not settled", stillRunning.settled === false);
check("and is not reported as a failure", stillRunning.task?.status === "running");
check("it stops at the deadline rather than looping forever", clock <= 6_000 + 2_000, String(clock));

clock = 0;
reply(200, { ok: true, task: { id: "abc123", status: "stopped", title: "done" } });
const settled = await awaitTask(ENV, "abc123", {
  maxWaitMs: 60_000, intervalMs: 1_000, now: fakeNow, sleep: fakeSleep,
});
check("a stopped task settles immediately", settled.settled === true);
check("without sleeping", clock === 0, String(clock));

// ---------------------------------------------------------------- 10. prompt
console.log("\n[10] the prompt is grounded and bounded");
const rows = [
  article({ id: 1, title: "Cambodia solar plant approved", source: "AKP", category: "Investment" }),
  article({ id: 2, title: "Fed raises rates", source: "AKP", category: "Banking" }),
];
const prompt = buildManusPrompt(rows, FX, { hours: 72 });
check("states the instruction", prompt.includes("business analyst for Khmer24"));
check("includes the signal titles", prompt.includes("Cambodia solar plant approved"));
check("includes the category tag", prompt.includes("[Investment]"));
check("includes the exchange rates", prompt.includes("USD/KHR"));
check("states the window", prompt.includes("72 hours"));
check("asks for the actionable closing", prompt.includes("WHAT KHMER24 SHOULD DO TODAY"));
check("forbids inventing facts", /Never invent/i.test(prompt));
check("says where to stop when data is missing", /not in the signals/i.test(prompt));
check("the instruction carries no unverified API claims", !prompt.includes("manus.ai"));
check("the instruction itself is included verbatim", prompt.startsWith(MANUS_INSTRUCTION.slice(0, 60)));

console.log("\n[11] the prompt cannot grow without limit");
const many = Array.from({ length: 200 }, (_, i) => article({ id: i, title: `Story ${i} `.repeat(30) }));
const big = buildManusPrompt(many, FX);
check("caps the number of signals", (big.match(/^- \[/gm) ?? []).length <= 45,
  String((big.match(/^- \[/gm) ?? []).length));
check("truncates long titles", !big.includes("Story 0 ".repeat(21)));
check("empty input still produces a valid prompt",
  buildManusPrompt([], null).includes("(none)"));
check("no fx renders without an FX block", !buildManusPrompt(rows, null).includes("USD/KHR"));

console.log("\n[12] output is trimmed for Telegram, and says so");
const long = ("line of analysis\n").repeat(400);
const fitted = fitForTelegram(long);
check("fits the limit", fitted.length <= 3600, String(fitted.length));
check("announces the truncation", fitted.includes("shortened"));
check("does not claim to be complete", !fitted.endsWith("line of analysis"));
const short = "WHAT MATTERS\nall good";
check("short text is untouched", fitForTelegram(short) === short);
check("CRLF is normalised", fitForTelegram("a\r\nb") === "a\nb");

// ---------------------------------------------------------------- 13. settings
console.log("\n[13] the settings surface");
check("three profiles offered", MANUS_PROFILES.length === 3);
check("standard is offered", MANUS_PROFILES.includes("standard"));
check("lite is offered", MANUS_PROFILES.includes("lite"));
check("max is offered", MANUS_PROFILES.includes("max"));
check("every profile is explained to the user",
  MANUS_PROFILES.every((p) => Boolean(MANUS_PROFILE_HELP_FOR_TESTS[p]?.label && MANUS_PROFILE_HELP_FOR_TESTS[p]?.note)));
check("explanations are distinct",
  new Set(MANUS_PROFILES.map((p) => MANUS_PROFILE_HELP_FOR_TESTS[p]!.note)).size === 3);
check("Manus is off by default, because it spends credits", DEFAULT_PREFS.manus === false);
check("the default profile is standard", DEFAULT_PREFS.manusProfile === "standard");

console.log("\n[13b] the settings page renders");
const counts = Object.fromEntries(SECTION_META ? Object.keys(SECTION_META).map((k) => [k, 3]) : []);
const pageOn = renderSettings({ ...DEFAULT_PREFS, manus: true }, { counts, basePath: "", manusConfigured: true });
const pageOff = renderSettings({ ...DEFAULT_PREFS, manus: false }, { counts, basePath: "", manusConfigured: false });
check("the card is on the page", pageOn.includes("Manus agent"));
check("the checkbox is checked when on", /name="manus"\s+checked/.test(pageOn));
check("the checkbox is not checked when off", !/name="manus"\s+checked/.test(pageOff));
check("every profile is in the dropdown", MANUS_PROFILES.every((p) => pageOn.includes(`value="${p}"`)));
check("the saved profile is selected", pageOn.includes(`value="standard" selected`));
check("it says a key is installed when one is", pageOn.includes("An API key is installed"));
check("it says how to install one when none is", pageOff.includes("wrangler secret put MANUS_API_KEY"));
check("it warns that it costs credits", /spends credits/i.test(pageOn));
check("it says the brief is not delayed", /not delayed/i.test(pageOn));
check("the page is valid enough to close", pageOn.trimEnd().endsWith("</html>"));

console.log("\n[14] the menu reflects the setting");
const offMenu = JSON.stringify(buildRootMenu({ ...DEFAULT_PREFS, manus: false }));
const onMenu = JSON.stringify(buildRootMenu({ ...DEFAULT_PREFS, manus: true }));
check("a Manus toggle is always present", offMenu.includes("Manus deep analysis"));
check("the run button is hidden while off", !offMenu.includes("Deep analysis with Manus"));
check("the run button appears when on", onMenu.includes("Deep analysis with Manus"));
check("the profile is shown", offMenu.includes("standard"));
check("the profile has its own cycle button", offMenu.includes("cycle:manusprofile"));

console.log("\n[15] toggling Manus writes through");
// A minimal in-memory D1. It must serve reads as well as accept writes: a stub
// whose SELECT always returns empty makes every cycle restart from the default,
// which silently turns a wrap-around test into a "does it increment" test.
const store = new Map<string, string>();
const fakeDb = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        const isInsert = /INSERT INTO prefs/i.test(sql);
        if (isInsert && args.length >= 2) store.set(String(args[0]), String(args[1]));
        return { success: true };
      },
    }),
    all: async () => ({
      results: [...store.entries()].map(([key, value]) => ({ key, value })),
    }),
  }),
} as unknown as D1Database;

const toggled = await handleToggle(fakeDb, "kb24:toggle:manus");
check("toggle reports the change", toggled.changed && toggled.prefs.manus === true, toggled.note);
check("it says what it did", toggled.note.includes("ON"), toggled.note);
check("the value is persisted", store.get("manus") === "1", store.get("manus") ?? "(missing)");

store.clear();
const cycled = await handleToggle(fakeDb, "kb24:manusprofile");
check("cycling changes the profile", cycled.changed && cycled.prefs.manusProfile !== "standard", cycled.note);
check("cycling persists it", store.get("manus_profile") === cycled.prefs.manusProfile);
const second = await handleToggle(fakeDb, "kb24:manusprofile");
const third = await handleToggle(fakeDb, "kb24:manusprofile");
check("each press moves to a different profile",
  second.prefs.manusProfile !== cycled.prefs.manusProfile &&
  third.prefs.manusProfile !== second.prefs.manusProfile);
check("cycling wraps back to the default", third.prefs.manusProfile === "standard",
  `after 3 cycles: ${third.prefs.manusProfile}`);

// ---------------------------------------------------------------- 16. safety
console.log("\n[16] the key never reaches the browser");
const page = MENUS_FOR_TESTS.rootText();
check("menu text has no key", !page.includes("test-key-not-real"));
check("all sections still reachable", MENUS_FOR_TESTS.sections().length === 8);
check("every section has metadata",
  MENUS_FOR_TESTS.sections().every((s) => Boolean(SECTION_META[s])));

// ---------------------------------------------------------------- restore
globalThis.fetch = realFetch;

console.log(`\n${"=".repeat(56)}`);
console.log(`  passed: ${pass}   failed: ${fail}`);
if (fail > 0) {
  console.log("\n  failures above.");
  process.exit(1);
}
console.log("\n  all green - Manus requests and settings are correct");
