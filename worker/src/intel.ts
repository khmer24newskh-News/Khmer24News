/**
 * The 8-section Business Intelligence report, and the synthesis engine that
 * turns news into a decision.
 *
 * The synthesis is deliberately rule-based and transparent: every recommendation
 * names the articles that triggered it. No opaque scoring, no invented numbers.
 */
import { SECTION_META, SOURCE_BY_ID, type Section } from "./registry.ts";
import { TRACKED_CURRENCIES, formatRate, fxSignal, type FxRates } from "./market.ts";
import { prettyAge } from "./classify.ts";
import type { Article } from "./db.ts";

export interface SectionBlock {
  section: Section;
  title: string;
  emoji: string;
  lines: string[];
  empty: boolean;
}

export interface Opportunity {
  headline: string;
  because: string[];
  customer: string;
  action: string;
  categories: string[];
  urgency: "act today" | "this week" | "watch";
}

/** Group stored articles into the report's sections by their source. */
export function groupBySection(rows: Article[]): Map<Section, Article[]> {
  const out = new Map<Section, Article[]>();
  for (const row of rows) {
    const src = SOURCE_BY_ID[row.source];
    const section: Section = src?.section ?? "cambodia";
    if (!out.has(section)) out.set(section, []);
    out.get(section)!.push(row);
  }
  return out;
}

const clean = (url: string | null | undefined): string => {
  if (!url) return "";
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:" ? url : "";
  } catch {
    return "";
  }
};

function newsLine(a: Article, i: number): string[] {
  const url = clean(a.url);
  return [
    `${i}. ${a.title}`,
    `   ${a.source} | ${prettyAge(a.age_hours)} | ${a.category} | score ${a.score}`,
    `   Opportunity: ${a.opportunity}`,
    `   Action: ${a.action}`,
    ...(url ? [`   ${url}`] : []),
  ];
}

// ---------------------------------------------------------------------------
// Synthesis: NEWS -> IMPACT -> CUSTOMER -> OPPORTUNITY -> ACTION
// ---------------------------------------------------------------------------
/** An article plus the report section its source belongs to. */
type Scored = Article & { section: string };

interface Rule {
  id: string;
  match: (a: Scored) => boolean;
  headline: string;
  because: (a: Scored) => string;
  customer: string;
  action: string;
  categories: string[];
  urgency: Opportunity["urgency"];
}

const RULES: Rule[] = [
  {
    id: "investment-entry",
    match: (a) => a.category === "Investment" && a.score >= 45,
    headline: "New investment or project announced",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "The investor, its contractors and its staff - all need housing, transport, jobs listings and business services.",
    action: "Same day: build a lead list of the company and its suppliers, then pitch Khmer24 Business + Property + Job packages.",
    categories: ["Investment"],
    urgency: "act today",
  },
  {
    id: "regulation-change",
    match: (a) => a.category === "Government & Regulation" && a.score >= 40,
    headline: "Policy, tax or customs change to watch",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Every affected seller, importer and service business in that sector.",
    action: "Read the article, list the affected categories, and prepare a short advisory post plus a targeted ad campaign.",
    categories: ["Government & Regulation"],
    urgency: "this week",
  },
  {
    id: "rate-move",
    match: (a) => a.category === "Banking" && a.score >= 40,
    headline: "Central bank or lending signal",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Borrowers, car and property buyers, and finance companies advertising loans.",
    action: "Check whether rates moved. If they did, Auto and Property sellers financing purchases are a ready-made campaign.",
    categories: ["Banking", "Auto", "Property"],
    urgency: "this week",
  },
  {
    id: "jobs-demand",
    match: (a) => a.category === "Jobs & Hiring" && a.score >= 40,
    headline: "Hiring, wage or labour-market signal",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Employers recruiting, and job seekers who will pay for visibility.",
    action: "Pitch the hiring company a Job Category package, and target job seekers with boosted listings.",
    categories: ["Jobs & Hiring"],
    urgency: "act today",
  },
  {
    id: "tourism-demand",
    match: (a) => a.category === "Tourism" && a.score >= 40,
    headline: "Tourism and visitor-demand signal",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Hotels, restaurants, transport, gift shops and anyone hiring seasonal staff.",
    action: "Target hospitality businesses in the affected province with Job + Marketplace + Property packages.",
    categories: ["Tourism", "Jobs & Hiring", "Marketplace"],
    urgency: "this week",
  },
  {
    id: "property-signal",
    match: (a) => a.category === "Property" && a.score >= 40,
    headline: "Property and construction activity",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Developers, agents, landlords and construction suppliers.",
    action: "Approach the developer or agency with a Property Category package and a featured-listing offer.",
    categories: ["Property"],
    urgency: "this week",
  },
  {
    id: "auto-signal",
    match: (a) => a.category === "Auto" && a.score >= 40,
    headline: "Automotive market movement",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Dealers, importers and used-car sellers.",
    action: "Offer affected dealers a bundled Auto advertising package for the new model or price point.",
    categories: ["Auto"],
    urgency: "this week",
  },
  {
    id: "trade-macro",
    match: (a) => a.category === "Marketplace" && a.score >= 40,
    headline: "Trade or consumer-market signal",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Importers, exporters, wholesalers and marketplace sellers.",
    action: "Map the affected product categories and run a seller-targeting campaign on Marketplace.",
    categories: ["Marketplace"],
    urgency: "watch",
  },
  {
    id: "ai-opportunity",
    match: (a) => a.category === "Technology & AI" && a.score >= 40,
    headline: "AI or technology development with a business angle",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Sellers and SMEs who could adopt the technology to cut cost or reach more buyers.",
    action: "Write a one-paragraph plain-language explainer and offer it as a lead magnet for Business-category listings.",
    categories: ["Technology & AI", "Jobs & Hiring"],
    urgency: "watch",
  },
  {
    id: "macro-rate",
    match: (a) => a.section === "global" && a.score >= 30,
    headline: "Global rate or macro move",
    because: (a) => `"${a.title.slice(0, 110)}"`,
    customer: "Borrowers, importers and exporters sensitive to USD funding costs.",
    action: "Watch the KHR rate for 48 hours. If it moves, brief sellers on import-cost changes before they reprice.",
    categories: ["Cambodia Economy", "Marketplace"],
    urgency: "watch",
  },
];

function sectionOf(a: Article): string {
  return SOURCE_BY_ID[a.source]?.section ?? "cambodia";
}

export function synthesise(rows: Article[], fx: FxRates | null): Opportunity[] {
  const scored: Scored[] = rows
    .map((a) => ({ ...a, section: sectionOf(a) }))
    .filter((a) => a.age_hours === null || a.age_hours <= 72);

  const found: Opportunity[] = [];
  for (const rule of RULES) {
    const hits = scored.filter(rule.match).slice(0, 3);
    if (hits.length === 0) continue;
    found.push({
      headline: rule.headline,
      because: hits.map((h) => `- ${rule.because(h)} (${h.source})`),
      customer: rule.customer,
      action: rule.action,
      categories: rule.categories,
      urgency: rule.urgency,
    });
  }

  const signal = fxSignal(fx);
  if (signal) {
    found.unshift({
      headline: "Riel moves against the dollar",
      because: [`- USD/KHR is ${formatRate("KHR", fx)} (${fx!.provider})`],
      customer: "Importers paying in USD, and exporters earning in USD.",
      action: signal,
      categories: ["Marketplace"],
      urgency: "act today",
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------
export interface IntelReport {
  generatedAt: string;
  sections: SectionBlock[];
  fx: FxRates | null;
  opportunities: Opportunity[];
  warnings: string[];
  totalArticles: number;
  /** Present only when Workers AI contributed. */
  analyst?: { headline: string; summary: string; risks: string[] } | null;
}

/** The shape applyAnalysis needs, kept structural so tests can supply it. */
export interface AnalysisLike {
  used: boolean;
  headline: string;
  summary: string;
  risks: string[];
  opportunities: {
    headline: string;
    evidence: string[];
    customer: string;
    action: string;
    categories: string[];
    urgency: Opportunity["urgency"];
  }[];
}

/**
 * Fold the AI analysis into the report.
 *
 * Rules stay authoritative: the deterministic opportunities are kept and the
 * AI ones are appended and labelled "(AI)". A hallucination therefore cannot
 * quietly displace a recommendation that was derived from a real article.
 */
export function applyAnalysis(report: IntelReport, ai: AnalysisLike): void {
  if (!ai.used) return;
  report.analyst = { headline: ai.headline, summary: ai.summary, risks: ai.risks };

  const block = report.sections.find((s) => s.section === "opportunity");
  if (!block) return;

  const extra = ai.opportunities.map((o) => ({
    headline: `${o.headline} (AI)`,
    because: o.evidence.length ? o.evidence.map((e) => `- ${e}`) : ["- derived from today's signals"],
    customer: o.customer,
    action: o.action,
    categories: o.categories,
    urgency: o.urgency,
  }));
  if (extra.length === 0) return;

  const existing = report.opportunities;
  report.opportunities = [...existing, ...extra];
  block.lines = [
    ...block.lines,
    "",
    "\u{1F9E0} AI ANALYST ADDITIONS",
    `   ${ai.headline}`,
    ...(ai.risks.length ? [`   Risks: ${ai.risks.join("; ")}`] : []),
    "",
    ...extra.flatMap((o, i) => [
      `${existing.length + i + 1}. [${o.urgency.toUpperCase()}] ${o.headline}`,
      `   Why: ${o.because.join("; ")}`,
      `   Customer: ${o.customer}`,
      `   ACTION: ${o.action}`,
    ]),
  ];
  block.empty = false;
}

export function buildIntelReport(
  rows: Article[],
  fx: FxRates | null,
  warnings: string[] = [],
): IntelReport {
  const grouped = groupBySection(rows);
  const order: Section[] = ["cambodia", "asean", "global", "tech", "competitor", "customer"];

  const sections: SectionBlock[] = order.map((section) => {
    const meta = SECTION_META[section];
    const list = grouped.get(section) ?? [];
    let lines: string[];
    if (section === "money") {
      lines = [];
    } else if (section === "competitor") {
      const notes = Object.values(SOURCE_BY_ID)
        .filter((s) => s.section === "competitor")
        .map((s) => `- ${s.label}: ${s.note ?? "no feed"} - not yet tracked`);
      lines = notes;
    } else if (section === "customer") {
      // Derived rather than sourced: demand signals read out of the news we have.
      const demand = rows
        .filter((a) => a.category === "Marketplace" || a.category === "Jobs & Hiring" || a.category === "Tourism")
        .slice(0, 5);
      lines = demand.length
        ? demand.map((a, i) => `${i + 1}. ${a.title}\n   implies: ${a.opportunity}`)
        : ["- No demand signals in the last 72 hours."];
    } else {
      lines = list.length
        ? list.slice(0, 4).flatMap((a, i) => newsLine(a, i + 1))
        : ["- Nothing new."];
    }
    return {
      section,
      title: meta.title,
      emoji: meta.emoji,
      lines,
      empty: list.length === 0 && section !== "competitor" && section !== "customer" && section !== "money",
    };
  });

  // Money block is built from live FX.
  const moneyLines = TRACKED_CURRENCIES.map((c) => {
    const v = formatRate(c.code, fx);
    return `${c.flag} USD/${c.code}  ${v === "n/a" ? "n/a" : v}   (${c.name})`;
  });
  if (fx) moneyLines.push(`   source: ${fx.provider} at ${new Date(fx.fetchedAt).toISOString().slice(0, 16)}Z`);
  else moneyLines.push("   FX provider unreachable - try again later.");
  moneyLines.push("   Oil / gold: not available without a paid API key (see DEPLOY.md).");
  sections.unshift({
    section: "money",
    title: SECTION_META.money.title,
    emoji: SECTION_META.money.emoji,
    lines: moneyLines,
    empty: false,
  });

  const opportunities = synthesise(rows, fx);

  const oppBlock: SectionBlock = {
    section: "opportunity",
    title: SECTION_META.opportunity.title,
    emoji: SECTION_META.opportunity.emoji,
    lines: opportunities.length
      ? opportunities.flatMap((o, i) => [
          `${i + 1}. [${o.urgency.toUpperCase()}] ${o.headline}`,
          `   Why: ${o.because.join("; ")}`,
          `   Customer: ${o.customer}`,
          `   ACTION: ${o.action}`,
        ])
      : ["- No strong signals in the last 72 hours. Hold the pipeline steady."],
    empty: opportunities.length === 0,
  };
  sections.push(oppBlock);

  return {
    generatedAt: new Date().toISOString(),
    sections,
    fx,
    opportunities,
    warnings,
    totalArticles: rows.length,
  };
}

/** Render the report as Telegram-sized messages. */
export function renderIntelMessages(report: IntelReport, maxLen = 4096): string[] {
  const head =
    `\u{1F1F0}\u{1F1ED} KHMER24 BUSINESS INTELLIGENCE` +
    `\n\u{1F4C5} ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Phnom_Penh" })}` +
    `\n${report.totalArticles} signals | ${report.opportunities.length} opportunities\n`;
  const messages: string[] = [];
  let current = head;

  const flush = () => {
    if (current.trim()) messages.push(current.trimEnd());
    current = "";
  };

  for (const block of report.sections) {
    const title = `\n${block.emoji} ${block.title}\n`;
    const lines = block.lines.map((l) => (l.startsWith("   ") || /^\d+\./.test(l) ? l : `   ${l}`));

    // Split the body into chunks that fit. A single oversized section must not
    // produce an over-limit message: Telegram rejects anything above 4096, and
    // the whole report would be lost.
    const budget = maxLen - head.length - title.length - 24;
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length > budget && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        size = 0;
      }
      chunk.push(line);
      size += line.length + 1;
    }
    if (chunk.length > 0) chunks.push(chunk);
    if (chunks.length === 0) chunks.push([]);

    chunks.forEach((c, i) => {
      const section = `${i === 0 ? title : `\n(cont. ${block.title})\n`}${c.join("\n")}`;
      if (current.length + section.length > maxLen && current !== head) {
        flush();
        current = section;
      } else {
        current += section;
      }
    });
  }
  flush();

  if (report.warnings.length) {
    const w = `\n\u{26A0}\u{FE0F} Coverage gaps: ${report.warnings.join("; ")}`;
    if ((messages[messages.length - 1]!.length + w.length) <= maxLen) {
      messages[messages.length - 1] = messages[messages.length - 1]! + w;
    } else {
      messages.push(w.trim());
    }
  }
  return messages.filter((m) => m.trim().length > 0);
}

export { clean as cleanUrl };
