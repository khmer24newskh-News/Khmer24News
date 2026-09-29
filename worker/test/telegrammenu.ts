/** Tests for the Telegram menu: keyboard shape, tap handling, and the locks. */
import {
  CLOSE, MENU_PREFIX, NO_KEYBOARD, SEND_NOW, buildKeyboard, buildKeyboardWithUrl,
  handleToggle, menuCaption,
} from "../src/telegrammenu.ts";
import { ALL_SECTIONS, DEFAULT_PREFS, loadPrefs, savePrefs, URGENCIES, type Prefs } from "../src/prefs.ts";
import { SECTION_META } from "../src/registry.ts";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` - ${d}` : ""}`); }
};

/** D1 stub for the key/value prefs table. */
class PrefsD1 {
  store = new Map<string, string>();
  writes = 0;
  prepare(sql: string) {
    const self = this;
    const api = {
      params: [] as unknown[],
      bind(...params: unknown[]) { api.params = params; return api; },
      async all() {
        if (!/FROM prefs/.test(sql)) return { results: [] };
        return {
          results: [...self.store.entries()].map(([key, value]) => ({ key, value })),
        };
      },
      async run() {
        if (/INSERT INTO prefs/.test(sql)) {
          self.store.set(String(api.params[0]), String(api.params[1]));
          self.writes++;
        }
        return { success: true, meta: { changes: 1 } };
      },
      async first() { return null; },
    };
    return api;
  }
}

const fresh = () => new PrefsD1() as PrefsD1 & D1Database;
const tap = (db: D1Database, data: string) => handleToggle(db, `${MENU_PREFIX}:${data}`);
const rows = (kb: unknown) => (kb as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard;
const flat = (kb: unknown) => rows(kb).flat();
const sectionRows = (kb: unknown) => rows(kb).filter((r) => r[0]!.callback_data?.includes(":sec:"));

console.log("[1] keyboard shape");
const kb = buildKeyboard(DEFAULT_PREFS);
const all = flat(kb);
check("has a keyboard", Array.isArray(rows(kb)));
check("all 8 sections have a button", sectionRows(kb).length === 8, String(sectionRows(kb).length));
check("every callback is under the prefix",
  all.every((b) => !b.callback_data || b.callback_data.startsWith(MENU_PREFIX)));
check("every callback fits Telegram's 64-byte limit",
  all.every((b) => (b.callback_data ?? "").length <= 64),
  String(Math.max(...all.map((b) => (b.callback_data ?? "").length))));
check("urgency button present", all.some((b) => b.callback_data === `${MENU_PREFIX}:urg`));
check("AI button present", all.some((b) => b.callback_data === `${MENU_PREFIX}:ai`));
check("send-now button present", all.some((b) => b.callback_data === SEND_NOW));
check("close button present", all.some((b) => b.callback_data === CLOSE));
check("keyboard is within 100 buttons", all.length <= 100, String(all.length));

console.log("\n[2] state is visible on the buttons");
const onKb = buildKeyboard(DEFAULT_PREFS);
check("active sections show a tick", sectionRows(onKb).filter((r) => r[0]!.text.startsWith("\u2705")).length === 6);
const offKb = buildKeyboard({ ...DEFAULT_PREFS, sections: ["money", "tech", "opportunity"] });
// 8 sections, 3 active, 2 of which are locked and carry no tick at all,
// so 5 of the 6 toggleable sections show an empty box.
const boxes = sectionRows(offKb).filter((r) => r[0]!.text.startsWith("\u2B1C")).length;
const ticks = sectionRows(offKb).filter((r) => r[0]!.text.startsWith("\u2705")).length;
check("inactive sections show an empty box", boxes === 5, String(boxes));
check("the one active toggleable section shows a tick", ticks === 1, String(ticks));
check("locked sections carry no mark at all",
  sectionRows(offKb).filter((r) => r[0]!.text.includes("always on")).length === 2);
check("AI state shown on the button",
  flat(buildKeyboard({ ...DEFAULT_PREFS, ai: false })).some((b) => b.callback_data === `${MENU_PREFIX}:ai` && b.text.includes("off")));
check("urgency level shown on the button",
  flat(buildKeyboard({ ...DEFAULT_PREFS, minUrgency: "act today" })).some((b) => b.text.includes("act today")));

console.log("\n[3] the dashboard link is filled in");
const withUrl = buildKeyboardWithUrl(DEFAULT_PREFS, "https://example.com/settings") as {
  inline_keyboard: { url?: string }[][]
};
const link = withUrl.inline_keyboard.flat().find((b) => b.url);
check("url button exists", Boolean(link));
check("url is the settings page", link?.url === "https://example.com/settings");
check("the bare keyboard has no url", !flat(kb).some((b) => b.url));

console.log("\n[4] the locks");
const moneyRow = sectionRows(kb).find((r) => r[0]!.text.includes("MONEY"))!;
const oppRow = sectionRows(kb).find((r) => r[0]!.text.includes("OPPORTUNIT"))!;
check("money cannot be turned off", moneyRow[0]!.text.includes("always on"), moneyRow[0]!.text);
check("opportunity cannot be turned off", oppRow[0]!.text.includes("always on"), oppRow[0]!.text);
const lockedMoney = flat(kb).find((b) => b.text.includes("MONEY"))!;
check("locked button still explains itself on tap",
  lockedMoney.callback_data === `${MENU_PREFIX}:sec:money`);

console.log("\n[5] toggling a section");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const off = await tap(db, "sec:tech");
  check("reports it went off", off.note.includes("off"), off.note);
  check("marks the change", off.changed === true);
  check("tech removed", !off.prefs.sections.includes("tech"));
  check("persisted", !(await loadPrefs(db)).sections.includes("tech"));
  const on = await tap(db, "sec:tech");
  check("reports it went on", on.note.includes("on"), on.note);
  check("tech back", on.prefs.sections.includes("tech"));
  check("persisted back", (await loadPrefs(db)).sections.includes("tech"));
}

console.log("\n[6] every non-locked section is toggleable");
{
  for (const s of ALL_SECTIONS.filter((x) => x !== "money" && x !== "opportunity")) {
    const db = fresh();
    await savePrefs(db, DEFAULT_PREFS);
    const off = await tap(db, `sec:${s}`);
    check(`${s} turns off`, off.changed && !off.prefs.sections.includes(s));
    const on = await tap(db, `sec:${s}`);
    check(`${s} turns on`, on.changed && on.prefs.sections.includes(s));
  }
}

console.log("\n[7] locked sections never change anything");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const before = (await loadPrefs(db)).sections.join(",");
  const writes = db.writes;
  for (const s of ["money", "opportunity"]) {
    const r = await tap(db, `sec:${s}`);
    check(`${s} explains itself`, r.note.includes("part of every brief"), r.note);
    check(`${s} does not mark a change`, r.changed === false);
  }
  check("nothing was written", db.writes === writes, `${db.writes} vs ${writes}`);
  check("sections untouched", (await loadPrefs(db)).sections.join(",") === before);
}

console.log("\n[8] a forged section is rejected");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const r = await tap(db, "sec:definitely-not-a-section");
  check("no crash, no change", r.changed === false);
  check("still all 8 sections", r.prefs.sections.length === 8);
}

console.log("\n[9] urgency cycles through every level and comes back");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const start = DEFAULT_PREFS.minUrgency;
  const seen: string[] = [];
  for (let i = 0; i < URGENCIES.length; i++) {
    const r = await tap(db, "urg");
    seen.push(r.prefs.minUrgency);
    check(`step ${i + 1} reported`, r.note === `Urgency: ${r.prefs.minUrgency}`, r.note);
  }
  check("visited every level in order", seen.join(",") === URGENCIES.join(","), seen.join(","));
  // URGENCIES.length taps from the start must land back on the start.
  check("returns to where it began", seen[seen.length - 1] === start, seen[seen.length - 1]);
  const round = await tap(db, "urg");
  check("the next tap starts over at the tightest level",
    round.prefs.minUrgency === URGENCIES[0], round.prefs.minUrgency);
  check("and it persisted", (await loadPrefs(db)).minUrgency === URGENCIES[0]);
}

console.log("\n[10] AI toggle");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const off = await tap(db, "ai");
  check("off", off.prefs.ai === false && off.note.includes("off"));
  check("persisted", (await loadPrefs(db)).ai === false);
  const on = await tap(db, "ai");
  check("on", on.prefs.ai === true && on.note.includes("on"));
}

console.log("\n[11] taps the route owns are not treated as toggles");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  const writes = db.writes;
  for (const data of ["send", "close", "noop", "garbage"]) {
    const r = await tap(db, data);
    check(`${data} changes nothing`, r.changed === false && r.note === "", JSON.stringify(r));
  }
  check("no writes for those", db.writes === writes, `${db.writes} vs ${writes}`);
}

console.log("\n[12] the caption reflects the settings");
{
  const narrow: Prefs = {
    ...DEFAULT_PREFS, sections: ["money", "customer", "opportunity"],
    minUrgency: "act today", ai: false, hours: 24,
  };
  const c = menuCaption(narrow);
  check("lists only the active sections",
    c.includes("MONEY") && c.includes("CUSTOMER") && !c.includes("GLOBAL"), c.split("\n")[2] ?? "");
  check("shows the urgency", c.includes("act today"));
  check("shows AI as off", c.includes("AI analyst: off"));
  check("shows the window", c.includes("24h"));
  check("mentions the 07:30 brief", c.includes("07:30"));
  check("stays under Telegram's message limit", c.length < 4096, String(c.length));
  const all8 = menuCaption(DEFAULT_PREFS);
  check("all 8 named when everything is on",
    ALL_SECTIONS.every((s) => all8.includes(SECTION_META[s].title)));
}

console.log("\n[13] an empty keyboard removes the buttons");
check("NO_KEYBOARD is an empty inline keyboard",
  Array.isArray(NO_KEYBOARD.inline_keyboard) && NO_KEYBOARD.inline_keyboard.length === 0);

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
