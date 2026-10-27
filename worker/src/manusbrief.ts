/**
 * What we ask Manus, and how we read the answer back.
 *
 * Manus is not a chat completion: it is an agent that browses, runs code and
 * writes files. That is worth paying for on the one question the rule engine
 * cannot answer - "given all of this, what should Khmer24 do next week?" - and
 * wasteful on per-article summarising, which the rules already do for free.
 *
 * So this builds one bounded, self-contained brief and asks for a written
 * analysis. The prompt repeats the constraints rather than relying on a system
 * message, because an agent task has no system channel.
 */

import type { Article } from "./db.ts";
import type { FxRates } from "./market.ts";
import { formatRate } from "./market.ts";
import { SOURCE_BY_ID, SECTION_META, type Section } from "./registry.ts";

export const MANUS_INSTRUCTION = `You are the business analyst for Khmer24, a Cambodian classifieds
marketplace with Job, Marketplace, Auto, Property and Business categories.

Below are today's news signals and exchange rates. Write a short analysis for the
owner of Khmer24.

Rules:
- Ground every claim in one of the supplied signals. Never invent a number,
  company or event, and never browse for more news - the signals are the input.
- Say "not in the signals" rather than guessing.
- Be concrete about the customer and the action: "employers hiring for garment
  factories who need to fill 40 roles", not "businesses that hire".
- Prefer three strong opportunities over ten weak ones.
- Keep it under 400 words. Plain text, no markdown tables, no code blocks.

Use exactly this structure:

WHAT MATTERS
Two or three sentences on the most commercially important thing today.

OPPORTUNITIES
For each: a one-line headline, then "Customer:", then "Action:".

RISKS
One to three lines.

WHAT KHMER24 SHOULD DO TODAY
A numbered list of three concrete actions, each starting with a verb.`;

/** Cap the signal list so the prompt stays inside the API's input limit. */
const MAX_SIGNALS = 45;

/**
 * Build the task text.
 *
 * Signals are grouped by section and tagged with their category, because the
 * section is what makes an item actionable and a flat list loses that. Titles
 * are truncated per item so forty-five of them stay readable.
 */
export function buildManusPrompt(rows: Article[], fx: FxRates | null, opts: { hours?: number; now?: Date } = {}): string {
  const hours = opts.hours ?? 72;
  const now = opts.now ?? new Date();
  const grouped = new Map<Section, string[]>();

  for (const a of rows.slice(0, MAX_SIGNALS)) {
    const src = SOURCE_BY_ID[a.source];
    const section = (src?.section ?? "cambodia") as Section;
    const line = `- [${a.category}] ${a.title.slice(0, 150)}`;
    const list = grouped.get(section) ?? [];
    list.push(line);
    grouped.set(section, list);
  }

  const order: Section[] = ["cambodia", "asean", "global", "money", "tech", "competitor", "customer", "opportunity"];
  const blocks: string[] = [];
  for (const s of order) {
    const items = grouped.get(s);
    if (!items?.length) continue;
    blocks.push(`${SECTION_META[s].title.toUpperCase()}\n${items.join("\n")}`);
  }

  const rates = fx
    ? [
        "EXCHANGE RATES",
        `USD/KHR ${formatRate("KHR", fx)}   USD/THB ${formatRate("THB", fx)}   USD/VND ${formatRate("VND", fx)}`,
        `USD/CNY ${formatRate("CNY", fx)}   USD/EUR ${formatRate("EUR", fx)}   USD/JPY ${formatRate("JPY", fx)}`,
      ].join("\n")
    : "";

  return [
    MANUS_INSTRUCTION,
    "",
    `SIGNALS - ${rows.length} article(s) from the last ${hours} hours, gathered ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    blocks.join("\n\n") || "(none)",
    rates ? `\n${rates}` : "",
  ]
    .filter((p) => p !== "")
    .join("\n");
}

/**
 * Trim an agent's answer to something that fits a Telegram message.
 *
 * Truncation is announced rather than silent: a cut-off list that looks
 * complete is worse than one that says it was cut.
 */
export function fitForTelegram(text: string, limit = 3500): string {
  const clean = text.trim().replace(/\r\n/g, "\n");
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  // Prefer a line boundary so the result does not end mid-sentence.
  const lastBreak = cut.lastIndexOf("\n");
  const body = lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}\n\n[shortened - the full analysis is open in Manus]`;
}
