/**
 * Report building. Returns a LIST of Telegram-sized messages so nothing is ever
 * silently truncated - the Python version used to slice to 3900 chars and could
 * cut the SALES FOCUS section in half.
 */
import { DEFAULT_LOOKBACK_HOURS, GENERAL_CATEGORY, GENERAL_PLAYBOOK, PLAYBOOK, TELEGRAM_MAX_LEN } from "./config.ts";
import { categoryCounts, getArticles, type Article } from "./db.ts";
import { prettyAge } from "./classify.ts";
import { buildBreakingCard, isBreaking } from "./breaking.ts";

/** "breaking" = a card per HIGH article, compact batch for the rest. */
export type AlertStyle = "breaking" | "cards" | "compact";

/** A message to send, and whether Telegram should render its link preview. */
export interface AlertMessage {
  text: string;
  linkPreview: boolean;
  /** How many stored articles this message accounts for. */
  articles: number;
}

/** Only http(s) may reach an href. */
export function safeExternalUrl(url: string | null | undefined): string {
  if (!url) return "#";
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

export async function buildDailyReport(
  db: D1Database,
  opts: { top?: number; hours?: number } = {},
): Promise<string[]> {
  const top = opts.top ?? 8;
  const hours = opts.hours ?? DEFAULT_LOOKBACK_HOURS;

  const rows = await getArticles(db, { limit: top, hours });
  const stamp = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Phnom_Penh",
  });
  const header =
    `\u{1F1F0}\u{1F1ED} KHMER24 DAILY BUSINESS INTELLIGENCE\n` +
    `\u{1F4C5} ${stamp} (last ${hours}h)`;

  if (rows.length === 0) {
    return [
      `${header}\n\nNo new signals in the last ${hours} hours. ` +
        `Widen the window (e.g. /?hours=720) or run a manual collect.`,
    ];
  }

  const messages: string[] = [];
  let chunk: string[] = [header, "", "\u{1F525} TOP BUSINESS OPPORTUNITIES"];

  const flush = () => {
    if (chunk.length > 1) messages.push(chunk.join("\n").slice(0, TELEGRAM_MAX_LEN).trimEnd());
  };

  rows.forEach((row, i) => {
    const n = i + 1;
    const block = [
      "",
      `${n}. ${row.title}`,
      `   Source: ${row.source} | ${prettyAge(row.age_hours)} | score ${row.score}`,
      `   Category: ${row.category}`,
      `   Opportunity: ${row.opportunity}`,
      `   Action: ${row.action}`,
      `   ${safeExternalUrl(row.url)}`,
    ];
    if ((chunk.join("\n") + block.join("\n")).length > TELEGRAM_MAX_LEN) {
      flush();
      chunk = [
        "",
        `(continued) ${n}. ${row.title}`,
        `   Source: ${row.source} | ${prettyAge(row.age_hours)} | score ${row.score}`,
        `   Opportunity: ${row.opportunity}`,
        `   Action: ${row.action}`,
        `   ${safeExternalUrl(row.url)}`,
      ];
    } else {
      chunk.push(...block);
    }
  });
  flush();

  // Only categories that actually have a sales playbook. Counting
  // "General Business" here would claim leads nobody can act on.
  const counts = (await categoryCounts(db, hours)).filter((c) => c.category in PLAYBOOK);
  const unclassified = (await categoryCounts(db, hours))
    .filter((c) => !(c.category in PLAYBOOK))
    .reduce((sum, c) => sum + c.n, 0);

  if (counts.length > 0) {
    const focus = ["\u{1F3AF} SALES FOCUS TODAY"];
    for (const c of counts.slice(0, 5)) {
      focus.push(`   • ${c.category}: ${c.n} signal(s) - review affected customers and create leads.`);
    }
    if (unclassified > 0) {
      focus.push(`   (+${unclassified} uncategorised signal(s) - open and classify by hand.)`);
    }
    const candidate = focus.join("\n");
    if (messages.length > 0 && (messages[messages.length - 1]! + "\n" + candidate).length <= TELEGRAM_MAX_LEN) {
      messages[messages.length - 1] = messages[messages.length - 1]! + "\n" + candidate;
    } else {
      messages.push(candidate.slice(0, TELEGRAM_MAX_LEN));
    }
  }
  return messages.filter((m) => m.trim().length > 0);
}

/**
 * Streaming alerts: a card per article worth interrupting for, and a compact
 * batch for everything else.
 *
 * Never exceeds the Telegram limit. A card carries its own headline, category
 * and single link, so cards cannot share a message - batching them would
 * interleave the fields and Telegram would render one preview for the lot.
 */
export function buildAlertMessages(
  rows: Article[],
  perMessage: number,
  style: AlertStyle = "breaking",
): AlertMessage[] {
  if (rows.length === 0) return [];
  const size = Math.max(1, perMessage);
  const out: AlertMessage[] = [];

  if (style === "cards") {
    for (const row of rows) {
      out.push({ text: buildBreakingCard(row), linkPreview: true, articles: 1 });
    }
    return out;
  }

  const breaking = style === "breaking" ? rows.filter(isBreaking) : [];
  const rest = rows.filter((r) => !breaking.includes(r));

  for (const row of breaking) {
    out.push({ text: buildBreakingCard(row), linkPreview: true, articles: 1 });
  }

  for (let start = 0; start < rest.length; start += size) {
    const chunk = rest.slice(start, start + size);
    const stamp = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh",
    });
    const lines: string[] = [];
    if (start === 0 && breaking.length === 0) lines.push(`(as of ${stamp})`);
    lines.push(
      breaking.length === 0
        ? `\u{1F514} KHMER24 UPDATE (${rest.length} new article(s))`
        : `\u{1F514} KHMER24 UPDATE (${rest.length} more)`,
      "",
    );
    for (const row of chunk) {
      lines.push(`• ${row.title}`);
      if (hasSignal(row)) {
        lines.push(`   ${row.source} | ${prettyAge(row.age_hours)} | ${row.category} | score ${row.score}`);
        // Suppressed individually as well, so a half-filled row keeps the part
        // that is real instead of losing the whole breakdown.
        if (row.opportunity !== GENERAL_PLAYBOOK[0]) {
          lines.push(`   Opportunity: ${row.opportunity}`);
        }
        if (row.action !== GENERAL_PLAYBOOK[1]) {
          lines.push(`   Action: ${row.action}`);
        }
      }
      lines.push(`   ${safeExternalUrl(row.url)}`);
      lines.push("");
    }
    out.push({
      text: lines.join("\n").trimEnd().slice(0, TELEGRAM_MAX_LEN),
      linkPreview: false,
      articles: chunk.length,
    });
  }
  return out;
}

/**
 * Does this article carry a real classification?
 *
 * The category is the root of the decision - "no category keyword matched" is
 * decided there - so it alone is the test. The placeholder text is checked
 * separately when rendering, because a row can have a real category and still
 * have inherited a placeholder line.
 */
export function hasSignal(row: Article): boolean {
  return row.category !== GENERAL_CATEGORY;
}

export function summariseStats(s: {
  newCount: number; duplicate: number; stale: number; junk: number;
  offdomain: number; offTopic: number; undated: number;
  resolved: number; unresolved: number; durationMs: number;
}): string {
  return [
    `new=${s.newCount}`, `dup=${s.duplicate}`, `stale=${s.stale}`, `junk=${s.junk}`,
    `off-domain=${s.offdomain}`, `not-Cambodia=${s.offTopic}`, `undated=${s.undated}`,
    `resolved=${s.resolved}`, `unresolved=${s.unresolved}`, `${s.durationMs}ms`,
  ].join(" ");
}

export type { Article };
