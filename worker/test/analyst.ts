/** Tests for the Workers AI analyst: response shapes, JSON extraction, merging. */
import {
  extractJsonObject,
  parseAnalysis,
  normaliseModelText,
  buildBriefing,
  aiDisabled,
  DEFAULT_AI_MODEL,
} from "../src/analyst.ts";
import { buildIntelReport, applyAnalysis } from "../src/intel.ts";
import type { FxRates } from "../src/market.ts";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` - ${d}` : ""}`); }
};

const article = (over: Record<string, unknown> = {}) => ({
  id: 1, title: "Cambodia opens new solar plant", title_hash: "h", url: "https://e.com/a",
  google_url: "", source: "AKP", tier: 1, published: new Date().toISOString(), age_hours: 3,
  category: "Investment", score: 60, summary: "", signals: "investment",
  opportunity: "O", action: "A", created_at: new Date().toISOString(), ...over,
}) as never;

const FX = { base: "USD", fetchedAt: new Date().toISOString(), provider: "t",
  perUsd: { KHR: 4048, THB: 33, CNY: 6.7, VND: 25900 } } as FxRates;

console.log("[1] response shape normalisation");
check("plain string", normaliseModelText("hello") === "hello");
check("array of strings", normaliseModelText(["a", "b"]) === "ab");
check("array of text blocks", normaliseModelText([{ type: "text", text: "x" }]) === "x");
check("nested content array", normaliseModelText({ content: [{ type: "text", text: "deep" }] }) === "deep");
check("response wrapper", normaliseModelText({ response: "wrapped" }) === "wrapped");
check("openai envelope", normaliseModelText({ choices: [{ message: { content: "oai" } }] }) === "oai");
check("null and undefined", normaliseModelText(null) === "" && normaliseModelText(undefined) === "");
check("numbers ignored", normaliseModelText(42) === "");
check("recursion terminates on self-reference", normaliseModelText({ a: { a: { a: { a: {} } } } }) === "");
check("usage object yields no text", normaliseModelText({ usage: { prompt_tokens: 10 } }) === "");
check("skips empty then finds text",
  normaliseModelText({ text: "", content: "found" }) === "found");

console.log("\n[2] balanced JSON extraction");
check("simple object", extractJsonObject('{"a":1}') === '{"a":1}');
check("nested objects", extractJsonObject('{"a":{"b":{"c":2}}}') === '{"a":{"b":{"c":2}}}');
check("array of objects inside",
  extractJsonObject('{"o":[{"h":1},{"h":2}]}') === '{"o":[{"h":1},{"h":2}]}');
check("braces inside strings ignored",
  extractJsonObject('{"a":"has } brace"}') === '{"a":"has } brace"}');
check("escaped quote inside string",
  extractJsonObject('{"a":"say \\"hi\\"","b":2}') === '{"a":"say \\"hi\\"","b":2}');
check("leading prose is skipped",
  extractJsonObject('Thinking out loud. Here you go: {"a":1}') === '{"a":1}');
check("no json returns null", extractJsonObject("no braces here") === null);
const truncated = extractJsonObject('{"a":1,"b":{"c":2},"d":"unfinis');
check("truncated json salvaged", truncated !== null && truncated.endsWith("}"), String(truncated));

const nested = 'prefix {"a":{"b":1}} suffix';
check("nested object extracted whole", extractJsonObject(nested) === '{"a":{"b":1}}');

console.log("\n[3] parsing a real-shaped model response");
const good = `{
  "headline": "Cambodia opens a new solar plant",
  "summary": "A 200MW solar plant opened in Kampong Thom. The IMF also concluded its Article IV review.",
  "risks": ["Currency volatility"],
  "opportunities": [
    {"headline":"Renewable investment","evidence":["Cambodia opens new solar plant"],
     "customer":"Energy investors","action":"Target them with Business listings",
     "categories":["Investment","Cambodia Economy"],"urgency":"this week"}
  ]
}`;
const p = parseAnalysis(good);
check("parses cleanly", p !== null);
check("headline captured", p!.headline.includes("solar plant"));
check("one opportunity", p!.opportunities.length === 1);
check("evidence preserved", p!.opportunities[0]!.evidence[0]!.includes("solar plant"));
check("categories preserved", p!.opportunities[0]!.categories.includes("Investment"));
check("urgency preserved", p!.opportunities[0]!.urgency === "this week");
check("risks captured", p!.risks.length === 1);

console.log("\n[4] parser rejects and sanitises bad output");
check("empty string -> null", parseAnalysis("") === null);
check("prose only -> null", parseAnalysis("I cannot help with that.") === null);
check("fenced json is unwrapped", parseAnalysis('```json\n' + good + '\n```') !== null);
const badCategory = parseAnalysis('{"summary":"s","opportunities":[{"headline":"Something with a real headline","action":"do something useful here","categories":["Nonsense","Auto"],"urgency":"now"}]}');
check("unknown category dropped", badCategory!.opportunities[0]!.categories.join() === "Auto");
check("invalid urgency becomes watch", badCategory!.opportunities[0]!.urgency === "watch");
const shortHeadline = parseAnalysis('{"summary":"s","opportunities":[{"headline":"H","action":"do something useful here"}]}');
check("headline under 3 chars is dropped", shortHeadline!.opportunities.length === 0);
check("empty summary with no opps -> null",
  parseAnalysis('{"headline":"x","summary":"","opportunities":[]}') === null);
check("garbage array entries dropped",
  parseAnalysis('{"summary":"s","opportunities":[null,42,{"headline":"","action":""}]}')!.opportunities.length === 0);
check("truncated response still yields a headline",
  parseAnalysis(good.slice(0, good.length - 30))?.headline.includes("solar") === true);

console.log("\n[5] briefing");
const brief = buildBriefing([article(), article({ id: 2, source: "FED", title: "Fed holds rates" })], FX, 10);
check("includes headlines", brief.includes("solar plant") && brief.includes("Fed holds rates"));
check("includes section tags", brief.includes("[cambodia/Investment]") && brief.includes("[global/"));
check("includes FX", brief.includes("USD/KHR"));
check("respects the limit", buildBriefing([article()], FX, 1).split("\n").length <= 2);
check("works without fx", buildBriefing([article()], null, 5).includes("solar plant"));

console.log("\n[6] merging into the report");
const report = buildIntelReport([article()], FX, []);
const before = report.opportunities.length;
applyAnalysis(report, { used: true, headline: "H", summary: "S", risks: ["R"],
  opportunities: [{ headline: "AI idea", evidence: ["real article"], customer: "SMBs",
    action: "Target them", categories: ["Marketplace"], urgency: "act today" }] });
check("AI opportunities appended, not substituted", report.opportunities.length === before + 1);
check("rule opportunities still first", !report.opportunities[0]!.headline.includes("(AI)"));
check("AI one is labelled", report.opportunities.at(-1)!.headline.includes("(AI)"));
check("analyst summary stored", report.analyst?.summary === "S");
check("block marked non-empty",
  report.sections.find((s) => s.section === "opportunity")!.empty === false);
check("AI block appears in the text",
  report.sections.find((s) => s.section === "opportunity")!.lines.some((l) => l.includes("AI ANALYST ADDITIONS")));

const unused = buildIntelReport([article()], FX, []);
applyAnalysis(unused, { used: false, headline: "", summary: "", risks: [], opportunities: [] });
check("unused AI changes nothing", unused.analyst === undefined && unused.opportunities.length === before);
check("empty AI block is skipped",
  (() => {
    const r2 = buildIntelReport([article()], FX, []);
    applyAnalysis(r2, { used: true, headline: "H", summary: "S", risks: [], opportunities: [] });
    return r2.opportunities.length === before;
  })());

console.log("\n[7] guards");
check("AI_ANALYSIS=0 disables", aiDisabled({ AI_ANALYSIS: "0" } as never));
check("missing binding disables", aiDisabled({ AI_ANALYSIS: "1" } as never));
check("default enabled with a binding", !aiDisabled({ AI_ANALYSIS: "1", AI: {} } as never));
check("default model is not the deprecated one",
  !DEFAULT_AI_MODEL.includes("llama-3.1-8b-instruct'"), DEFAULT_AI_MODEL);
check("default model is a catalog id", DEFAULT_AI_MODEL.startsWith("@cf/"), DEFAULT_AI_MODEL);

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
