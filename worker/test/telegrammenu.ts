/** Tests for the Telegram menu: keyboard shape, tap handling, and the locks. */
import {
  CLOSE, MENU_PREFIX, NO_KEYBOARD, SEND_NOW, buildKeyboard, buildKeyboardWithUrl,
  buildSectionFooter, handleToggle, menuCaption,
  CATEGORY_KEYS, HOUR_STEPS,
  buildCategoryPage, buildRootMenu, buildSectionPage, buildSourcePage,
} from "../src/telegrammenu.ts";
import { ALL_SECTIONS, DEFAULT_PREFS, loadPrefs, savePrefs, URGENCIES, type Prefs } from "../src/prefs.ts";
import { ALL_SOURCES, SECTION_META } from "../src/registry.ts";

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
const rows = (kb: unknown) =>
  (kb as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard;
/** Flattens rows into individual buttons. */
const flat = (kb: unknown): { text: string; callback_data?: string; url?: string }[] =>
  rows(kb).flat();
const sectionRows = (kb: unknown) => rows(kb).filter((r) => r[0]!.callback_data?.includes(":see:"));

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
  sectionRows(offKb).filter((r) => r[0]!.text.includes("always in")).length === 2,
  String(sectionRows(offKb).filter((r) => r[0]!.text.includes("always in")).length));
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
check("money is labelled as always included", moneyRow[0]!.text.includes("always in"), moneyRow[0]!.text);
check("opportunity is labelled as always included", oppRow[0]!.text.includes("always in"), oppRow[0]!.text);

console.log("\n[4b] tapping a section shows it; the toggle lives in the view");
{
  // The button used to only flip a flag, which gave nothing to decide with.
  // Now it opens the section, and the brief toggle is one tap further in.
  for (const b of flat(kb).filter((x) => x.callback_data?.includes(":see:"))) {
    check(`${b.callback_data!.slice(MENU_PREFIX.length + 1)} opens its section`,
      b.callback_data!.startsWith(`${MENU_PREFIX}:see:`));
  }
  check("no section button toggles directly",
    !flat(kb).some((b) => b.callback_data?.includes(":sec:")) &&
    !flat(kb).some((b) => b.callback_data?.includes(":toggle:")));

  const inBrief = buildSectionFooter("tech", true) as { inline_keyboard: { text: string; callback_data: string }[][] };
  const outBrief = buildSectionFooter("tech", false) as { inline_keyboard: { text: string; callback_data: string }[][] };
  const inFlat = inBrief.inline_keyboard.flat();
  const outFlat = outBrief.inline_keyboard.flat();
  check("offers to remove it when it is in the brief",
    inFlat.some((b) => b.text.includes("Remove") && b.callback_data === `${MENU_PREFIX}:toggle:tech`),
    JSON.stringify(inFlat[0]));
  check("offers to add it when it is not",
    outFlat.some((b) => b.text.includes("Add") && b.callback_data === `${MENU_PREFIX}:toggle:tech`));
  check("both states still navigate back",
    inFlat.some((b) => b.callback_data === `${MENU_PREFIX}:back`) &&
    outFlat.some((b) => b.callback_data === `${MENU_PREFIX}:back`));

  const lockedFooter = buildSectionFooter("money", true) as { inline_keyboard: { callback_data: string }[][] };
  check("a locked section gets no remove button",
    !lockedFooter.inline_keyboard.flat().some((b) => b.callback_data?.includes(":toggle:")));

  // A keyboard rendered before this change is still sitting in old chats.
  const legacy = buildKeyboard(DEFAULT_PREFS) as { inline_keyboard: { callback_data?: string }[][] };
  check("the bare keyboard has no url", !flat(legacy).some((b) => b.url));
}

console.log("\n[5] toggling a section");
{
  const db = fresh();
  await savePrefs(db, DEFAULT_PREFS);
  // Both names must work: keyboards rendered before the rename still send "sec".
  const legacy = await tap(db, "sec:tech");
  check("the old 'sec' payload still works", legacy.changed === true && legacy.note.includes("off"), legacy.note);
  const back = await tap(db, "sec:tech");
  check("and toggles back", back.prefs.sections.includes("tech"));

  const off = await tap(db, "toggle:tech");
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

console.log("\n[13] every control in the site is reachable from the chat");
{
  const root = buildRootMenu(DEFAULT_PREFS) as { inline_keyboard: { text: string; callback_data: string }[][] };
  const flatRoot = root.inline_keyboard.flat();
  const all = [...flatRoot, ...flat(buildSectionPage(DEFAULT_PREFS)), ...flat(buildCategoryPage(DEFAULT_PREFS)),
               ...flat(buildSourcePage(DEFAULT_PREFS, 0))];

  for (const [name, needle] of [
    ["sections", "Sections"], ["sources", "Sources"], ["categories", "Categories"],
    ["window", "Window"], ["AI", "AI analyst"],
    ["auto-send", "auto-send"], ["send now", "Send the brief"], ["status", "Status"],
  ] as const) {
    check(`the menu offers ${name}`, all.some((b) => b.text.includes(needle)), all.map((b) => b.text).join(" | "));
  }
  // The urgency button shows whichever level is current, so any of the three counts.
  check("the menu offers urgency",
    all.some((b) => URGENCIES.some((u) => b.text.includes(u))),
    all.map((b) => b.text).join(" | "));

  // Telegram rejects callback_data over 64 bytes, and several source ids are long
  // enough to blow the limit once a prefix is added. Indexing avoids that class
  // of bug entirely.
  const tooLong = all.filter((b) => new TextEncoder().encode(b.callback_data).length > 64);
  check("every callback fits Telegram's 64-byte limit", tooLong.length === 0,
    tooLong.map((b) => `${b.callback_data} (${new TextEncoder().encode(b.callback_data).length})`).join(", "));
  check("no callback exceeds 64 bytes even on the last source page",
    flat(buildSourcePage(DEFAULT_PREFS, 3)).every(
      (b) => new TextEncoder().encode(b.callback_data).length <= 64));

  const buttons = all.length;
  check("a keyboard stays well under Telegram's 100-button limit", buttons <= 100, String(buttons));
}

console.log("\n[14] toggling sources, categories, window and auto-send");
{
  const mk = () => fresh();
  const tap = (db: D1Database, data: string) => handleToggle(db, `${MENU_PREFIX}:${data}`);

  // Sources, by index.
  const db1 = mk();
  await savePrefs(db1, DEFAULT_PREFS);
  const firstId = ALL_SOURCES[0]!.id;
  const off = await tap(db1, "tsrc:0");
  check("a source can be turned off", off.changed && !off.prefs.sources.includes(firstId), off.note);
  check("and it names the source", off.note.includes(ALL_SOURCES[0]!.label.slice(0, 12)), off.note);
  const on = await tap(db1, "tsrc:0");
  check("and back on", on.prefs.sources.includes(firstId));

  // The last source index must work, or pagination silently drops entries.
  const lastIdx = ALL_SOURCES.length - 1;
  const lastOff = await tap(db1, `tsrc:${lastIdx}`);
  check("the last source is reachable by index",
    !lastOff.prefs.sources.includes(ALL_SOURCES[lastIdx]!.id), lastOff.note);

  // A bad index must not corrupt anything.
  const bad = await tap(db1, "tsrc:9999");
  check("an out-of-range index changes nothing", bad.changed === false && bad.note === "");

  // Categories.
  const db2 = mk();
  await savePrefs(db2, DEFAULT_PREFS);
  const cat = CATEGORY_KEYS[0]!;
  const cOff = await tap(db2, "tcat:0");
  check("a category can be turned off", cOff.changed && !cOff.prefs.categories.includes(cat));
  check("and back on", (await tap(db2, "tcat:0")).prefs.categories.includes(cat));

  // Sections by index.
  const db3 = mk();
  await savePrefs(db3, DEFAULT_PREFS);
  const techIdx = ALL_SECTIONS.indexOf("tech");
  const sOff = await tap(db3, `tsec:${techIdx}`);
  check("a section can be turned off by index", sOff.changed && !sOff.prefs.sections.includes("tech"), sOff.note);
  const moneyIdx = ALL_SECTIONS.indexOf("money");
  const locked = await tap(db3, `tsec:${moneyIdx}`);
  check("money stays locked by index too", locked.changed === false && locked.note.includes("part of every brief"), locked.note);

  // Window cycles through the whole ladder and returns to where it started.
  const db4 = mk();
  await savePrefs(db4, DEFAULT_PREFS);
  const startIdx = HOUR_STEPS.indexOf(DEFAULT_PREFS.hours);
  const expected = HOUR_STEPS.map((_, i) => HOUR_STEPS[(startIdx + 1 + i) % HOUR_STEPS.length]);
  const seen: number[] = [];
  for (let i = 0; i < HOUR_STEPS.length; i++) seen.push((await tap(db4, "hours")).prefs.hours);
  check("the window cycles through every option in order",
    seen.join(",") === expected.join(","), `${seen.join(",")} expected ${expected.join(",")}`);
  // A full lap returns to the start, so the last value is the start value.
  check("a full lap returns to the start",
    seen[seen.length - 1] === DEFAULT_PREFS.hours, `${seen[seen.length - 1]} vs ${DEFAULT_PREFS.hours}`);
  check("every offered window is a sane one",
    HOUR_STEPS.every((h) => h >= 1 && h <= 720), HOUR_STEPS.join(","));

  // Auto-send. It shares the "toggle:" prefix with section ids, so this also
  // guards against it being dispatched to the section case and silently ignored.
  const db5 = mk();
  await savePrefs(db5, DEFAULT_PREFS);
  const as1 = await tap(db5, "toggle:autosend");
  check("auto-send can be turned off", as1.prefs.autoSend === false);
  check("and says what that means", as1.note.includes("nothing is sent"), as1.note);
  check("and back on", (await tap(db5, "toggle:autosend")).prefs.autoSend === true);

  // AI shares the same prefix and must not be read as a section either.
  const db6 = mk();
  await savePrefs(db6, DEFAULT_PREFS);
  const ai1 = await tap(db6, "toggle:ai");
  check("AI toggles through the same payload", ai1.prefs.ai === false && ai1.note.includes("off"), ai1.note);

  // An unknown name after toggle: must not be mistaken for a section.
  const db7 = mk();
  await savePrefs(db7, DEFAULT_PREFS);
  const unknown = await tap(db7, "toggle:nonsense");
  check("an unknown toggle changes nothing",
    unknown.changed === false && unknown.prefs.sections.length === 8, JSON.stringify(unknown));
}

console.log("\n[15] source pagination");
{
  const pages = Math.ceil(ALL_SOURCES.length / 10);
  const first = buildSourcePage(DEFAULT_PREFS, 0) as { inline_keyboard: { text: string; callback_data: string }[][] };
  const flatFirst = first.inline_keyboard.flat();
  check("page 1 has sources", first.inline_keyboard.filter((r) => r[0]!.callback_data.includes("tsrc")).length > 0);
  check("page 1 shows a next link", flatFirst.some((b) => b.text.includes("Next")));
  check("page 1 has no back link", !flatFirst.some((b) => b.text === "\u{2190} Back"));

  const mid = buildSourcePage(DEFAULT_PREFS, 1) as { inline_keyboard: { text: string }[][] };
  const flatMid = mid.inline_keyboard.flat();
  check("page 2 has both links",
    flatMid.some((b) => b.text.includes("Back")) && flatMid.some((b) => b.text.includes("Next")));

  const last = buildSourcePage(DEFAULT_PREFS, pages - 1) as { inline_keyboard: { text: string }[][] };
  check("the last page has no next link",
    !last.inline_keyboard.flat().some((b) => b.text.includes("Next")));
  const allSourceIds = Array.from({ length: pages }, (_, p) => flat(buildSourcePage(DEFAULT_PREFS, p)))
    .flat()
    .filter((b) => b.callback_data?.includes("tsrc"))
    .map((b) => b.callback_data!);
  check("every source appears exactly once across the pages",
    new Set(allSourceIds).size === ALL_SOURCES.length,
    `${new Set(allSourceIds).size} of ${ALL_SOURCES.length} across ${pages} pages`);

  // A page beyond the end must clamp, not render nothing.
  const beyond = buildSourcePage(DEFAULT_PREFS, 99) as { inline_keyboard: unknown[][] };
  check("a page past the end clamps instead of going blank",
    beyond.inline_keyboard.flat().filter((b) => (b as { callback_data?: string }).callback_data?.includes("tsrc")).length > 0);
}

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
