/** Test the Worker's alert logic against an in-memory-ish D1 stub. */
import { sendNewArticleAlerts, resetAlertWatermark, pendingAlerts } from "../src/alerts.ts";
import { buildAlertMessages, hasSignal } from "../src/report.ts";
import { buildBreakingCard, categoryLabel, severity } from "../src/breaking.ts";
import { countPendingAlerts } from "../src/db.ts";
import { GENERAL_CATEGORY, GENERAL_PLAYBOOK } from "../src/config.ts";
import type { Article } from "../src/db.ts";
import type { Env } from "../src/env.ts";

// ---- minimal D1 stub: enough SQL for the alert paths, records everything ----
type Row = Record<string, unknown>;
class FakeD1 {
  rows: Row[] = [];
  meta = new Map<string, string>();
  seq = 0;
  statements: string[] = [];

  prepare(sql: string) {
    this.statements.push(sql.trim().split("\n")[0]!.slice(0, 60));
    const self = this;

    const run = async () => {
      if (/INSERT INTO meta/.test(sql)) {
        // The key is a SQL literal in setWatermark; only the value is bound.
        self.meta.set("alert_watermark_id", String(api.params[0]));
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    };
    const first = async () => {
      if (/FROM meta/.test(sql)) {
        const v = self.meta.get("alert_watermark_id");
        return v === undefined ? null : { value: v };
      }
      if (/MAX\(id\)/.test(sql)) return { m: self.seq };
      if (/COUNT\(\*\)/.test(sql)) {
        return { n: self.rows.filter((r) => Number(r.id) > Number(api.params[0] ?? 0)).length };
      }
      return null;
    };
    const all = async () => {
      if (/FROM articles/.test(sql)) {
        const limit = Number(api.params[api.params.length - 1]);
        const rows = self.rows
          .filter((r) => Number(r.id) > Number(api.params[0]))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, limit);
        return { results: rows };
      }
      return { results: [] };
    };

    // Same behaviour whether or not .bind() is used, matching D1 closely enough.
    const api = {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        api.params = params;
        return api;
      },
      run,
      first,
      all,
    };
    return api;
  }
}

const dbFake = new FakeD1();
const db = dbFake as unknown as D1Database;

// Stub the send so no real messages go out during the test.
const sent: string[] = [];
let failSends = false;
const env = { DB: db, TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "1" } as Env;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("api.telegram.org")) {
    if (failSends) return new Response(JSON.stringify({ ok: false, description: "simulated" }), { status: 400 });
    sent.push(url);
    return new Response(JSON.stringify({ ok: true, result: { chat: { title: "TestChat", type: "private" } } }));
  }
  return realFetch(input);
}) as typeof fetch;

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n} - ${d}`); }
};

console.log("[1] first run primes the watermark and sends nothing");
dbFake.rows.push(...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Old ${i}`, source: "MEF", category: "Cambodia Economy", score: 50, opportunity: "O", action: "A", url: "https://e.com", age_hours: 2 })) as Row[]);
dbFake.seq = 5;
let r = await sendNewArticleAlerts(env);
check("backfilled", r.backfilled === true, JSON.stringify(r));
check("nothing sent", r.sentArticles === 0, JSON.stringify(r));
check("no telegram call", sent.length === 0);
check("watermark = 5", r.watermark === 5, String(r.watermark));

console.log("\n[1b] an article with no classification is reduced to headline and link");
{
  const plain = {
    id: 90, title: "Roundtables: The Deadly Failures of The Virtual Border Wall",
    source: "MITTR", category: GENERAL_CATEGORY, score: 34,
    opportunity: GENERAL_PLAYBOOK[0]!, action: GENERAL_PLAYBOOK[1]!,
    url: "https://www.technologyreview.com/2026/09/28/1144890/x/", age_hours: 9,
  } as unknown as Article;
  const rich = {
    id: 91, title: "Cambodia approves $200m industrial park",
    source: "CIB / CDC", category: "Investment", score: 71,
    opportunity: "Factory staff need housing.", action: "Pitch Property + Job packages.",
    url: "https://www.phnompenhpost.com/national/x", age_hours: 3,
  } as unknown as Article;

  check("no-signal article is detected", hasSignal(plain) === false);
  check("classified article is detected", hasSignal(rich) === true);

  // "compact" forces the batch formatter, so this tests it in isolation rather
  // than depending on whether an article happens to be breaking.
  const [plainMsg] = buildAlertMessages([plain], 3, "compact");
  const plainText = plainMsg!.text;
  check("keeps the headline", plainText.includes("Roundtables: The Deadly Failures"));
  check("keeps the url", plainText.includes("technologyreview.com"));
  check("drops the metadata line", !plainText.includes("MITTR |"));
  check("drops the score", !plainText.includes("score 34"));
  check("drops the category", !plainText.includes(GENERAL_CATEGORY));
  check("drops 'requiring review'", !plainText.includes("requiring review"));
  check("drops 'classify it by hand'", !plainText.includes("classify it by hand"));
  check("never says 'Opportunity:'", !plainText.includes("Opportunity:"));
  check("never says 'Action:'", !plainText.includes("Action:"));
  check("compact messages do not preview the link", plainMsg!.linkPreview === false);

  const [richMsg] = buildAlertMessages([rich], 3, "compact");
  const richText = richMsg!.text;
  check("classified keeps the source", richText.includes("CIB / CDC |"));
  check("classified keeps the score", richText.includes("score 71"));
  check("classified keeps the opportunity", richText.includes("Opportunity: Factory staff"));
  check("classified keeps the action", richText.includes("Action: Pitch Property"));

  const [both] = buildAlertMessages([plain, rich], 5, "compact");
  check("both kinds fit in one message",
    both!.text.includes("Roundtables") && both!.text.includes("industrial park"));
  check("mixed message drops only the empty lines",
    (both!.text.match(/Opportunity:/g) ?? []).length === 1,
    String((both!.text.match(/Opportunity:/g) ?? []).length));

  // A single noisy line per unclassified article is the whole point of the change.
  const many = Array.from({ length: 3 }, (_, i) => ({ ...plain, id: 100 + i }) as Article);
  const [bulk] = buildAlertMessages(many, 3, "compact");
  check("a batch of unclassified articles stays compact",
    (bulk!.text.match(/Opportunity:/g) ?? []).length === 0);
  check("all three headlines still present",
    bulk!.text.split("\n").filter((l) => l.startsWith("• ")).length === 3);
}

console.log("\n[1c] a half-classified row keeps the part that is real");
{
  // The category decides whether an article is classified, so a real category
  // must still show the breakdown even when one line is a placeholder.
  const row = {
    id: 95, title: "Something", source: "AKP", category: "Investment", score: 60,
    opportunity: GENERAL_PLAYBOOK[0]!, action: "Pitch it.", url: "https://e.com/1", age_hours: 4,
  } as unknown as Article;
  const [msg] = buildAlertMessages([row], 3, "compact");
  check("treated as carrying a signal", hasSignal(row) === true);
  check("keeps the metadata line", msg!.text.includes("AKP | 4 h ago | Investment | score 60"), msg!.text);
  check("drops only the placeholder opportunity", !msg!.text.includes("Opportunity:"));
  check("keeps the real action", msg!.text.includes("Action: Pitch it."));

  // And the mirror image: a real opportunity under the general category is
  // still unclassified, because the category is what the decision keys on.
  const other = {
    id: 96, title: "Something else", source: "AKP", category: GENERAL_CATEGORY, score: 30,
    opportunity: "A real opportunity.", action: GENERAL_PLAYBOOK[1]!,
    url: "https://e.com/2", age_hours: 5,
  } as unknown as Article;
  const [msg2] = buildAlertMessages([other], 3, "compact");
  check("general category is unclassified", hasSignal(other) === false);
  check("so no breakdown even with a real opportunity", !msg2!.text.includes("Opportunity:"), msg2!.text);
  check("but the headline and link survive",
    msg2!.text.includes("Something else") && msg2!.text.includes("e.com/2"));
}

console.log("\n[1d] breaking cards: structure, severity and splitting");
{
  const high = {
    id: 80, title: "China-US economic and trade consultations yield positive consensus",
    source: "PPP", category: "Cambodia Economy", score: 82,
    opportunity: "O", action: "A", age_hours: 4,
    url: "https://phnompenhpost.com/international/china-us-economic-and-trade-consultations-yield-positive-consensus/",
    summary: "BEIJING - China and the United States have reached an arrangement to reciprocally reduce tariffs on about $30 billion worth of goods from each side, with tariffs on around 90 percent of products covered to be lowered to most-favored-nation rates, the Ministry of Commerce announced on Monday.",
  } as unknown as Article;
  const routine = {
    id: 81, title: "Siem Reap hotel opens 120 rooms",
    source: "KHMERDAILY", category: "Tourism", score: 44,
    opportunity: "O", action: "A", age_hours: 6,
    url: "https://khmerdaily.com/t/hotel", summary: "SIEM REAP - A new hotel opened in the city centre.",
  } as unknown as Article;

  check("a foreign tariff shock is HIGH", severity(high) === "HIGH", categoryLabel(high));
  check("a domestic low-score story is routine", severity(routine) === "NORMAL", categoryLabel(routine));
  check("a Cambodian place name is not 'Regional'",
    categoryLabel(routine).startsWith("Cambodia "), categoryLabel(routine));

  const card = buildBreakingCard(high);
  check("header says BREAKING NEWS", card.startsWith("\u{1F6A8} BREAKING NEWS \u{2014} HIGH"), card.split("\n")[0]);
  check("has a Category line", /^Category: .+/m.test(card), card);
  check("labels the origin and type", card.includes("Category: China macro data or policy shock"), card);
  check("shows the headline", card.includes("China-US economic and trade consultations"));
  check("shows the publisher, not the registry id", card.includes("Source: Phnom Penh Post"));
  check("does not leak the topic id", !card.includes("Source: PPP"));
  check("includes the summary", card.includes("BEIJING - China and the United States"));
  check("has a Cambodia impact line",
    card.includes("\u{1F1F0}\u{1F1ED} Cambodia impact: review business, import-cost, inflation and financing exposure"),
    card);
  check("has a Source link line", card.includes("Source link: https://phnompenhpost.com/international/"));

  const routineCard = buildBreakingCard(routine);
  check("a routine card does not claim to be breaking",
    !routineCard.includes("BREAKING NEWS"), routineCard.split("\n")[0]);
  check("and says what it is", routineCard.startsWith("\u{1F4F0} KHMER24"), routineCard.split("\n")[0]);

  // One card per article: a card owns its headline and single link.
  const msgs = buildAlertMessages([high, routine], 3, "breaking");
  check("a card is its own message", msgs.length === 2, String(msgs.length));
  check("the HIGH article gets a preview", msgs[0]!.linkPreview === true);
  check("the routine article is batched, not previewed", msgs[1]!.linkPreview === false);
  check("each message accounts for one article",
    msgs.every((m) => m.articles === 1), JSON.stringify(msgs.map((m) => m.articles)));
  check("the batch is the compact format", msgs[1]!.text.includes("• Siem Reap"));

  const allCards = buildAlertMessages([high, routine], 3, "cards");
  check("'cards' style gives every article a card", allCards.length === 2);
  check("and previews them all", allCards.every((m) => m.linkPreview === true));

  const allCompact = buildAlertMessages([high, routine], 3, "compact");
  check("'compact' style batches everything", allCompact.length === 1, String(allCompact.length));
  check("and previews nothing", allCompact[0]!.linkPreview === false);
  check("no BREAKING header in compact mode", !allCompact[0]!.text.includes("BREAKING NEWS"));

  // A card must never exceed the limit, however long the summary is.
  const huge = { ...high, summary: "x".repeat(9000) } as Article;
  check("a huge summary is truncated", buildBreakingCard(huge).length <= 4096, String(buildBreakingCard(huge).length));
}

console.log("\n[1e] origin detection: the bugs that a substring match would cause");
{
  const mk = (over: Record<string, unknown>) => ({
    id: 70, opportunity: "O", action: "A", age_hours: 3, summary: null, ...over,
  } as unknown as Article);

  // "Autonomus"/"Autonomous" contains "us". A substring match filed this tech
  // story as United States macro policy, which then made it a breaking card.
  const autonomous = mk({
    title: "Anthropic prospectus details losses, growth, and an Autonomous truck warning",
    url: "https://www.technologyreview.com/a", source: "MITTR",
    category: "Cambodia Economy", score: 30,
  });
  check("'Autonomous' is not the United States",
    !categoryLabel(autonomous).startsWith("US"), categoryLabel(autonomous));
  check("and it does not become breaking", severity(autonomous) === "NORMAL");

  // Cambodia outranks the institution that reported on it.
  const imf = mk({
    title: "Cambodia's economic growth projected to slow to 3 pct: IMF",
    url: "https://www.chinaview.cn/x.html", source: "IMF Cambodia",
    category: "Cambodia Economy", score: 74,
    summary: "PHNOM PENH - Cambodia's growth is forecast to slow on rising energy costs.",
  });
  check("Cambodia outranks the IMF", categoryLabel(imf).startsWith("Cambodia "), categoryLabel(imf));
  check("and it is breaking", severity(imf) === "HIGH");

  // A Cambodian place name is enough.
  const siemReap = mk({
    title: "Siem Reap hotel opens 120 rooms", url: "https://khmerdaily.com/t/x",
    source: "KHMERDAILY", category: "Tourism", score: 44,
  });
  check("a place name counts as Cambodia", categoryLabel(siemReap).startsWith("Cambodia "), categoryLabel(siemReap));

  // Tier A shocks interrupt; Tier B shocks do not, on their own.
  const china = mk({
    title: "China imposes new export controls on rare earths", url: "https://www.scmp.com/a",
    source: "GLOBAL", category: "Marketplace", score: 70,
    summary: "BEIJING - China announced export controls, causing supply concerns.",
  });
  const indonesia = mk({
    title: "Rupiah weakens on rate hike fears", url: "https://www.fxstreet.com/a",
    source: "ASEAN-ID", category: "Banking", score: 70,
    summary: "JAKARTA - The rupiah slid after a surprise rate hike.",
  });
  check("a Tier A shock is breaking", severity(china) === "HIGH", categoryLabel(china));
  check("a Tier B shock stays quiet", severity(indonesia) === "NORMAL", categoryLabel(indonesia));

  // ...but a Tier B shock that mentions Cambodia is admitted.
  const indonesiaCambodia = mk({
    title: "Indonesia rate hike: what it means for Cambodia's garment exports",
    url: "https://www.fibre2fashion.com/a", source: "ASEAN-ID",
    category: "Banking", score: 70,
    summary: "JAKARTA - Analysts in Phnom Penh say the rate hike will hit Cambodian exports.",
  });
  check("a Tier B shock that names Cambodia is breaking",
    severity(indonesiaCambodia) === "HIGH", categoryLabel(indonesiaCambodia));

  // A currency ticker must not read as a country. "USD/IDR" matched "us" once
  // inflections were allowed on a two-letter needle, which filed rupiah news
  // as United States macro policy.
  const rupiah = mk({
    title: "Indonesian Rupiah holds ground despite inflation, oil risks",
    url: "https://www.fxstreet.com/news/rupiah", source: "ASEAN-ID",
    category: "Cambodia Economy", score: 62,
    summary: "USD/IDR inches lower after opening at a bullish gap, trading around 18,050 during the Asian hours on Tuesday.",
  });
  check("a USD ticker is not the United States",
    !categoryLabel(rupiah).startsWith("US "), categoryLabel(rupiah));
  check("it stays Indonesia", categoryLabel(rupiah).startsWith("Indonesia "), categoryLabel(rupiah));
  check("and it is not breaking", severity(rupiah) === "NORMAL", categoryLabel(rupiah));

  // The plural is what matters for the terms that have one.
  const plural = mk({
    title: "Tariffs lowered on $30 billion of trade", url: "https://www.scmp.com/a",
    source: "GLOBAL", category: "Cambodia Economy", score: 70,
    summary: "BEIJING - Tariffs on 90 percent of products will be cut.",
  });
  check("'Tariffs' still matches 'tariff'", severity(plural) === "HIGH", categoryLabel(plural));
}

console.log("\n[2] nothing new is a no-op");
r = await sendNewArticleAlerts(env);
check("nothing sent", r.sentArticles === 0);
check("no telegram call", sent.length === 0);
check("no error", r.error === null);

console.log("\n[3] new articles are sent, oldest first");
for (let i = 6; i <= 9; i++) {
  dbFake.rows.push({ id: i, title: `New ${i}`, source: "NBC", category: "Banking", score: 55, opportunity: "O", action: "A", url: `https://e.com/${i}`, age_hours: 1 } as Row);
  dbFake.seq = i;
}
r = await sendNewArticleAlerts(env);
check("4 sent", r.sentArticles === 4, JSON.stringify(r));
check("batched", r.sentMessages >= 1, JSON.stringify(r));
check("watermark advanced", r.watermark === 9, String(r.watermark));
check("nothing pending", r.pending === 0, String(r.pending));

console.log("\n[4] no duplicates on the next run");
const before = sent.length;
r = await sendNewArticleAlerts(env);
check("nothing re-sent", r.sentArticles === 0);
check("no new telegram calls", sent.length === before);

console.log("\n[5] a FAILED send does not advance the watermark");
for (let i = 10; i <= 13; i++) {
  dbFake.rows.push({ id: i, title: `Fail ${i}`, source: "AKP", category: "Tourism", score: 40, opportunity: "O", action: "A", url: "https://e.com", age_hours: 1 } as Row);
  dbFake.seq = i;
}
failSends = true;
r = await sendNewArticleAlerts(env);
check("error surfaced", r.error !== null, JSON.stringify(r));
check("nothing counted as sent", r.sentArticles === 0, JSON.stringify(r));
check("watermark NOT advanced", r.watermark === 9, String(r.watermark));
check("still pending for retry", (await countPendingAlerts(db)) === 4, String(await countPendingAlerts(db)));

console.log("\n[6] retry after the failure succeeds");
failSends = false;
r = await sendNewArticleAlerts(env);
check("backlog delivered", r.sentArticles === 4, JSON.stringify(r));
check("watermark caught up", r.watermark === 13, String(r.watermark));
check("nothing pending", (await countPendingAlerts(db)) === 0);

console.log("\n[7] the per-tick cap staggers a large backlog");
for (let i = 14; i <= 60; i++) {
  dbFake.rows.push({ id: i, title: `Bulk ${i}`, source: "MLVT", category: "Jobs & Hiring", score: 30, opportunity: "O", action: "A", url: "https://e.com", age_hours: 1 } as Row);
  dbFake.seq = i;
}
const total = await countPendingAlerts(db);
let sentTotal = 0, ticks = 0;
do {
  const res = await sendNewArticleAlerts(env);
  sentTotal += res.sentArticles;
  ticks++;
  if (res.sentArticles === 0 || ticks > 30) break;
} while (true);
check("backlog larger than one cap", total > 20, String(total));
check("everything eventually sent", sentTotal === total, `${sentTotal}/${total}`);
check("took multiple ticks", ticks > 1, String(ticks));
check("nothing left pending", (await countPendingAlerts(db)) === 0);

console.log("\n[8] reset mutes alerts but keeps data");
const mark = await resetAlertWatermark(env);
check("watermark = max id", mark === 60, String(mark));
check("rows retained", dbFake.rows.length === 60,
  String(dbFake.rows.length));
check("nothing pending", (await pendingAlerts(env)).length === 0);

console.log("\n[9] message shape and size limits");
const rows = [
  { id: 1, title: "A".repeat(900), source: "MEF", category: "Cambodia Economy", score: 50, opportunity: "O", action: "A", url: "https://e.com/1", age_hours: 1 },
  { id: 2, title: "B".repeat(900), source: "NBC", category: "Banking", score: 40, opportunity: "O", action: "A", url: "https://e.com/2", age_hours: 3 },
] as never as Parameters<typeof buildAlertMessages>[0];
const msgs = buildAlertMessages(rows, 3, "compact");
check("one message for two rows", msgs.length === 1, String(msgs.length));
check("within 4096", msgs.every((m) => m.text.length <= 4096), String(msgs.map((m) => m.text.length)));
for (const needle of ["KHMER24 UPDATE", "Opportunity:", "Action:", "https://e.com/", "NBC", "Banking", "as of"]) {
  check(`contains ${needle}`, msgs[0]!.text.includes(needle));
}
check("batching respects perMessage",
  buildAlertMessages(rows, 1, "compact").length === 2,
  String(buildAlertMessages(rows, 1, "compact").length));
check("empty batch -> no messages", buildAlertMessages([], 3).length === 0);

console.log(`\n${"=".repeat(56)}\n  passed: ${pass}   failed: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
