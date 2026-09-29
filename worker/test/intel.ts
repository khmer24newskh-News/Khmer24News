/** Tests for the 8-section report, the synthesis engine and the market block. */
import {
  buildIntelReport,
  renderIntelMessages,
  synthesise,
  groupBySection,
  type IntelReport,
} from "../src/intel.ts";
import { formatRate, fxSignal, toKhr, type FxRates } from "../src/market.ts";
import { CLOUD_SOURCES, PUSH_SOURCES, LISTING_SOURCES, SOURCE_BY_ID, SECTION_META, queriesFor, sourceUrl } from "../src/registry.ts";
import { parseFeed, unwrapBingUrl, xmlUnescape, stripTags } from "../src/cloudfeeds.ts";
import { fetchFxRates } from "../src/market.ts";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` - ${d}` : ""}`); }
};

const article = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1, title: "Some headline", title_hash: "h", url: "https://example.com/a", google_url: "",
  source: "MEF", tier: 1, published: new Date().toISOString(), age_hours: 2,
  category: "Cambodia Economy", score: 50, summary: "", signals: "economy",
  opportunity: "O", action: "A", created_at: new Date().toISOString(), ...over,
}) as never;

const FX: FxRates = {
  base: "USD", fetchedAt: new Date().toISOString(), provider: "test",
  perUsd: { KHR: 4048.8, THB: 33.6, VND: 25917, CNY: 6.72, SGD: 1.28, MYR: 4.08, IDR: 17985, EUR: 0.88, JPY: 157.3 },
};

console.log("[1] registry integrity");
check("cloud + push + listing covers every source",
  CLOUD_SOURCES.length + PUSH_SOURCES.length + LISTING_SOURCES.length ===
  Object.keys(SOURCE_BY_ID).length);
check("no duplicate ids", new Set(Object.values(SOURCE_BY_ID).map((s) => s.id)).size === Object.keys(SOURCE_BY_ID).length);
check("every source has a section with metadata",
  Object.values(SOURCE_BY_ID).every((s) => Boolean(SECTION_META[s.section])));
check("every source the Worker fetches resolves to an https url",
  CLOUD_SOURCES.every((s) => {
    const url = sourceUrl(s);
    return url.startsWith("https://") && url.length > 0;
  }));
check("no source needs a local machine", PUSH_SOURCES.length === 0, String(PUSH_SOURCES.length));
check("every bing source has a query", queriesFor.length > 0 &&
  CLOUD_SOURCES.filter((s) => s.discovery === "bing").every((s) => queriesFor(s).length > 0));
check("every bing source has a keyword filter",
  CLOUD_SOURCES.filter((s) => s.discovery === "bing").every((s) => (s.mustMention?.length ?? 0) > 0));
check("bing sources are not filtered by publisher domain",
  CLOUD_SOURCES.filter((s) => s.discovery === "bing").every((s) => s.domain === ""));
check("bing queries are distinct", new Set(
  CLOUD_SOURCES.filter((s) => s.discovery === "bing").flatMap((s) => queriesFor(s)),
).size === CLOUD_SOURCES.filter((s) => s.discovery === "bing").flatMap((s) => queriesFor(s)).length);
check("all 8 sections have metadata", Object.keys(SECTION_META).length === 8);

console.log("\n[1b] Bing redirect unwrapping");
{
  const wrapped =
    "http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=6abb&" +
    "url=https%3a%2f%2fwww.bloomberg.com%2fnews%2farticles%2fx&c=1416&mkt=en-us";
  check("unwraps apiclick", unwrapBingUrl(wrapped) === "https://www.bloomberg.com/news/articles/x", unwrapBingUrl(wrapped));
  check("leaves a direct link alone",
    unwrapBingUrl("https://www.phnompenhpost.com/national/x") === "https://www.phnompenhpost.com/national/x");
  check("leaves a non-bing redirect alone",
    unwrapBingUrl("https://news.google.com/rss/articles/abc") === "https://news.google.com/rss/articles/abc");
  check("unwraps the https form too",
    unwrapBingUrl(wrapped.replace("http://", "https://")) === "https://www.bloomberg.com/news/articles/x");
  check("keeps the original when the inner url is missing",
    unwrapBingUrl("https://www.bing.com/news/apiclick.aspx?ref=FexRss").includes("bing.com"));
  check("keeps the original when the inner url is not http",
    unwrapBingUrl("https://www.bing.com/news/apiclick.aspx?url=javascript%3Aalert(1)").includes("bing.com"));
  check("never lengthens a url", unwrapBingUrl(wrapped).length < wrapped.length);
}

console.log("\n[2] RSS parsing");const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title><![CDATA[Fed holds rates &amp; signals caution]]></title>
    <link>https://www.federalreserve.gov/newsevents/pressreleases/x1.htm</link>
    <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Some <b>body</b> text</p>]]></description></item>
  <item><title>Second story</title><link>https://example.com/2</link>
    <pubDate>Sun, 27 Sep 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;
const items = parseFeed(rss, 10);
check("parsed 2 items", items.length === 2, String(items.length));
check("CDATA + entities unescaped", items[0]!.title === "Fed holds rates & signals caution", items[0]!.title);
check("link extracted", items[0]!.url.includes("federalreserve.gov"));
check("pubDate parsed to age", typeof items[0]!.ageHours === "number" && items[0]!.ageHours < 72);
check("description stripped of tags", items[0]!.summary === "Some body text", items[0]!.summary);
check("limit respected", parseFeed(rss, 1).length === 1);

const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom title</title><link href="https://example.com/atom"/>
  <updated>2026-09-28T10:00:00Z</updated></entry></feed>`;
check("atom parsed", parseFeed(atom, 5).length === 1);
check("atom href used", parseFeed(atom, 5)[0]!.url === "https://example.com/atom");
check("junk xml -> no items", parseFeed("<html>not a feed</html>").length === 0);
check("entities decoded", xmlUnescape("a &amp; b &lt;c&gt; &#39;d&#39;") === "a & b <c> 'd'");
check("stripTags removes scripts", !stripTags("<script>bad()</script>ok").includes("bad"));

console.log("\n[3] section grouping");
const rows = [
  article({ id: 1, source: "MEF" }),
  article({ id: 2, source: "TECHCRUNCH" }),
  article({ id: 3, source: "FED" }),
  article({ id: 4, source: "ASEAN" }),
  article({ id: 5, source: "PPP" }),
];
const grouped = groupBySection(rows);
check("MEF -> cambodia", grouped.get("cambodia")?.length === 2);
check("TECHCRUNCH -> tech", grouped.get("tech")?.length === 1);
check("FED -> global", grouped.get("global")?.length === 1);
check("ASEAN -> asean", grouped.get("asean")?.length === 1);
check("unknown source falls back to cambodia",
  groupBySection([article({ source: "NOPE" })]).get("cambodia")?.length === 1);

console.log("\n[4] synthesis engine");
const opps = synthesise([
  article({ id: 1, source: "CIB / CDC", category: "Investment", score: 60, title: "New factory to create 5000 jobs" }),
  article({ id: 2, source: "AKP", category: "Tourism", score: 55 }),
  article({ id: 3, source: "AKP", category: "Jobs & Hiring", score: 52 }),
  article({ id: 4, source: "AKP", category: "Government & Regulation", score: 50 }),
  article({ id: 5, source: "FED", category: "Banking", score: 45 }),
], FX);
check("produces opportunities", opps.length >= 5, String(opps.length));
check("every opportunity names its evidence",
  opps.every((o) => o.because.length > 0 && o.because.every((b) => b.length > 10)));
check("every opportunity has a customer", opps.every((o) => o.customer.length > 10));
check("every opportunity has an action", opps.every((o) => o.action.length > 15));
check("urgency is always one of three",
  opps.every((o) => ["act today", "this week", "watch"].includes(o.urgency)));
const weakKhr = synthesise([article({ category: "Investment", score: 60, source: "CIB / CDC" })],
  { ...FX, perUsd: { ...FX.perUsd, KHR: 4200 } });
check("weak riel produces a currency opportunity", weakKhr.some((o) => o.headline.includes("Riel")));
check("no currency note when fx is null",
  !synthesise([article({ category: "Investment", score: 60, source: "CIB / CDC" })], null)
    .some((o) => o.headline.includes("Riel")));

console.log("\n[5] market data");
check("formats KHR with 1 decimal", formatRate("KHR", FX) === "4,048.8", formatRate("KHR", FX));
check("formats EUR with 4 decimals", formatRate("EUR", FX) === "0.8800", formatRate("EUR", FX));
check("n/a when fx missing", formatRate("KHR", null) === "n/a");
check("n/a for untracked code", formatRate("XXX", FX) === "n/a");
check("toKhr cross-rate", Math.abs((toKhr("THB", FX) ?? 0) - 33.6 / 4048.8) < 0.0001);
check("weak riel signalled", (fxSignal({ ...FX, perUsd: { ...FX.perUsd, KHR: 4100 } }) ?? "").includes("weak"));
check("strong riel signalled", (fxSignal({ ...FX, perUsd: { ...FX.perUsd, KHR: 3900 } }) ?? "").includes("strong"));
check("neutral riel silent", fxSignal({ ...FX, perUsd: { ...FX.perUsd, KHR: 4000 } }) === null);
const live = await fetchFxRates();
check("live FX fetch returns KHR", live !== null && typeof live.perUsd.KHR === "number",
  live ? "ok" : "network unavailable in this environment");

console.log("\n[6] report assembly and rendering");
const report: IntelReport = buildIntelReport(rows, FX, ["competitors not tracked"]);
check("has all 8 sections", report.sections.length === 8, String(report.sections.length));
const order = report.sections.map((s) => s.section);
check("money first, opportunity last",
  order[0] === "money" && order[order.length - 1] === "opportunity", order.join(","));
check("opportunity section present", report.sections.some((s) => s.section === "opportunity"));
check("competitor section is honest, not empty",
  report.sections.find((s) => s.section === "competitor")!.lines.some((l) => l.includes("not yet tracked")));
check("money notes the missing commodity data",
  report.sections[0]!.lines.some((l) => l.includes("Oil / gold")));
check("warnings carried through", report.warnings.includes("competitors not tracked"));

const msgs = renderIntelMessages(report);
check("renders at least one message", msgs.length >= 1, String(msgs.length));
check("every message within the 4096 limit", msgs.every((m) => m.length <= 4096),
  JSON.stringify(msgs.map((m) => m.length)));
check("mentions the Cambodia section", msgs.join("").includes("CAMBODIA"));
check("mentions opportunities", msgs.join("").includes("BUSINESS OPPORTUNITIES"));
check("shows USD/KHR", msgs.join("").includes("USD/KHR"));

// buildIntelReport deliberately caps each section at 4 stories, so a big
// database does not produce a huge report. Splitting therefore has to be
// exercised by feeding genuinely oversized content, not by adding rows.
const many: IntelReport = {
  generatedAt: new Date().toISOString(),
  fx: FX,
  totalArticles: 999,
  warnings: [],
  opportunities: [],
  sections: [
    { section: "money", title: "MONEY", emoji: "M", empty: false, lines: Array.from({ length: 60 }, (_, i) => `line ${i} USD/KHR ${"9".repeat(80)}`) },
    { section: "cambodia", title: "CAMBODIA", emoji: "C", empty: false, lines: Array.from({ length: 60 }, (_, i) => `line ${i} headline ${"x".repeat(80)}`) },
  ],
};
const bigMsgs = renderIntelMessages(many);
check("oversized content splits into several messages", bigMsgs.length > 1, String(bigMsgs.length));
check("split messages all within limit", bigMsgs.every((m) => m.length <= 4096),
  JSON.stringify(bigMsgs.map((m) => m.length)));
check("split messages are non-empty", bigMsgs.every((m) => m.trim().length > 0));
check("no content lost when splitting", bigMsgs.join("").includes("line 0") && bigMsgs.join("").includes("line 59"));
check("each section only shows 4 stories by design",
  buildIntelReport(
    Array.from({ length: 30 }, (_, i) => article({ id: i, source: "TECHCRUNCH", title: `T${i}` })),
    FX, [],
  ).sections.find((s) => s.section === "tech")!.lines.filter((l) => /^\d+\./.test(l)).length === 4);

const empty = buildIntelReport([], null, []);
check("empty report still renders", renderIntelMessages(empty).length === 1);
check("empty report says nothing to report",
  renderIntelMessages(empty)[0]!.includes("No new signals") || renderIntelMessages(empty)[0]!.includes("No strong signals"));

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
