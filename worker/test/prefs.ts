/** Tests for preferences: validation, filtering, and the never-empty guarantee. */
import {
  ALL_SECTIONS, ALERT_STYLES, DEFAULT_PREFS, URGENCIES, applyPrefs, filterRows, sourcesByGroup,
} from "../src/prefs.ts";
// The settings page owns the human copy, so importing it here is what proves
// every style offered in the dropdown is actually explained to the user.
import { ALERT_STYLE_HELP_FOR_TESTS as ALERT_STYLE_HELP } from "../src/settingshtml.ts";
import { buildIntelReport } from "../src/intel.ts";
import { ALL_SOURCES, SECTION_META } from "../src/registry.ts";
import { CATEGORIES, GENERAL_CATEGORY } from "../src/config.ts";
import type { FxRates } from "../src/market.ts";
import type { Article } from "../src/db.ts";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` - ${d}` : ""}`); }
};

const article = (over: Record<string, unknown> = {}): Article => ({
  id: 1, title: "Cambodia solar plant", title_hash: "h", url: "https://e.com/a", google_url: "",
  source: "AKP", tier: 1, published: new Date().toISOString(), age_hours: 2,
  category: "Investment", score: 60, summary: "", signals: "investment",
  opportunity: "O", action: "A", created_at: new Date().toISOString(), ...over,
} as never);

const FX = { base: "USD", fetchedAt: new Date().toISOString(), provider: "t",
  perUsd: { KHR: 4048, THB: 33, CNY: 6.7, VND: 25900 } } as FxRates;

console.log("[1] defaults are coherent");
check("all 8 sections", DEFAULT_PREFS.sections.length === 8);
check("every section has metadata", DEFAULT_PREFS.sections.every((s) => Boolean(SECTION_META[s])));
check("every source selected", DEFAULT_PREFS.sources.length === ALL_SOURCES.length);
check("all categories selected",
  DEFAULT_PREFS.categories.length === Object.keys(CATEGORIES).length + 1);
check("includes the General fallback", DEFAULT_PREFS.categories.includes(GENERAL_CATEGORY));
check("urgency defaults to the loosest", DEFAULT_PREFS.minUrgency === "watch");
check("ai and auto-send on by default", DEFAULT_PREFS.ai && DEFAULT_PREFS.autoSend);
check("hours in range", DEFAULT_PREFS.hours >= 1 && DEFAULT_PREFS.hours <= 720);
check("urgency values are the three expected", URGENCIES.length === 3);

console.log("\n[2] source grouping for the settings UI");
const groups = sourcesByGroup();
check("groups produced", groups.length >= 5, String(groups.length));
check("every source appears exactly once",
  groups.flatMap((g) => g.items).length === ALL_SOURCES.length);
check("no duplicate sources across groups",
  new Set(groups.flatMap((g) => g.items.map((i) => i.id))).size === ALL_SOURCES.length);
check("how each source is fetched is explained",
  groups.flatMap((g) => g.items).every((i) => i.how.length > 3));

console.log("\n[3] row filtering");
const rows = [
  article({ id: 1, source: "AKP" }),
  article({ id: 2, source: "FED" }),
  article({ id: 3, source: "AKP", category: "Tourism" }),
];
check("all kept by default", filterRows(rows, DEFAULT_PREFS).length === 3);
check("source filter works",
  filterRows(rows, { ...DEFAULT_PREFS, sources: ["FED"] }).length === 1);
check("category filter works",
  filterRows(rows, { ...DEFAULT_PREFS, categories: ["Tourism"] }).length === 1);
check("both filters combine",
  filterRows(rows, { ...DEFAULT_PREFS, sources: ["AKP"], categories: ["Tourism"] }).length === 1);
check("impossible filter returns nothing",
  filterRows(rows, { ...DEFAULT_PREFS, sources: ["NOPE"] }).length === 0);

console.log("\n[4] section selection");
const report = buildIntelReport(rows, FX, []);
check("all 8 sections by default", report.sections.length === 8);
const trimmed = applyPrefs(report, { ...DEFAULT_PREFS, sections: ["money", "opportunity"] });
check("only the chosen sections remain", trimmed.sections.length === 2);
check("money kept", trimmed.sections.some((s) => s.section === "money"));
check("opportunity kept", trimmed.sections.some((s) => s.section === "opportunity"));
check("dropped sections are gone", !trimmed.sections.some((s) => s.section === "tech"));

console.log("\n[5] urgency threshold");
const opReport = buildIntelReport(
  [
    article({ id: 1, source: "CIB / CDC", category: "Investment", score: 60 }),
    article({ id: 2, source: "AKP", category: "Jobs & Hiring", score: 55 }),
    article({ id: 3, source: "AKP", category: "Tourism", score: 50 }),
  ],
  FX, [],
);
const all = applyPrefs(opReport, { ...DEFAULT_PREFS, minUrgency: "watch" });
const urgent = applyPrefs(opReport, { ...DEFAULT_PREFS, minUrgency: "act today" });
check("loosest threshold keeps the most", all.opportunities.length >= urgent.opportunities.length);
check("strict threshold keeps no more", urgent.opportunities.length <= all.opportunities.length);
check("strict threshold kept at least one", urgent.opportunities.length > 0);
const strictBlock = urgent.sections.find((s) => s.section === "opportunity")!;
check("block is renumbered from 1", strictBlock.lines[0]?.startsWith("1. ") === true);
check("renumbered lines are contiguous", strictBlock.lines
  .filter((l) => /^\d+\./.test(l))
  .map((l) => Number(l.match(/^(\d+)\./)![1]))
  .every((n, i) => n === i + 1));

console.log("\n[6] empty results are honest, not silent");
// A weak, unclassifiable story triggers no rule, so a strict threshold leaves
// nothing. The report must say so rather than rendering an empty section.
const none = applyPrefs(
  buildIntelReport([article({ category: GENERAL_CATEGORY, score: 8, source: "AKP" })], FX, []),
  { ...DEFAULT_PREFS, minUrgency: "act today" },
);
const noneBlock = none.sections.find((s) => s.section === "opportunity")!;
check("nothing survived the threshold", none.opportunities.length === 0, String(none.opportunities.length));
check("explains how to see more",
  noneBlock.lines.some((l) => l.includes("urgency threshold")), noneBlock.lines.join(" | "));
check("marked empty", noneBlock.empty === true);

console.log("\n[7] AI toggle");
const withAi = applyPrefs(
  buildIntelReport([article({ source: "CIB / CDC", category: "Investment", score: 60 })], FX, []),
  DEFAULT_PREFS,
);
withAi.opportunities.push({
  headline: "AI generated idea (AI)", because: ["x"], customer: "c", action: "a",
  categories: ["Investment"], urgency: "act today",
});
const aiOn = applyPrefs(withAi, { ...DEFAULT_PREFS, ai: true });
const aiOff = applyPrefs(withAi, { ...DEFAULT_PREFS, ai: false });
check("ai on keeps the AI item", aiOn.opportunities.some((o) => o.headline.includes("(AI)")));
check("ai off drops the AI item", !aiOff.opportunities.some((o) => o.headline.includes("(AI)")));
check("ai off keeps the rule items", aiOff.opportunities.some((o) => !o.headline.includes("(AI)")));

console.log("\n[8] every section is selectable");
check("ALL_SECTIONS matches the report's sections",
  ALL_SECTIONS.length === buildIntelReport(rows, FX, []).sections.length);
check("each section can be the only one selected",
  ALL_SECTIONS.every((s) => {
    const r = applyPrefs(buildIntelReport(rows, FX, []), { ...DEFAULT_PREFS, sections: [s] });
    return r.sections.length === 1 && r.sections[0]!.section === s;
  }));

console.log("\n[13] alert style settings");
check("three styles offered", ALERT_STYLES.length === 3);
check("breaking is the default", DEFAULT_PREFS.alertStyle === "breaking");
check("breaking-only is off by default", DEFAULT_PREFS.breakingOnly === false);
check("every style has copy in the settings page",
  ALERT_STYLES.every((s) => ALERT_STYLE_HELP[s]!.label.length > 5 && ALERT_STYLE_HELP[s]!.note.length > 20));
check("the styles are distinct", new Set(ALERT_STYLES).size === 3);

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
