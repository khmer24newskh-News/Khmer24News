/**
 * Workers AI analyst.
 *
 * The deterministic rule engine in intel.ts remains the backbone: it is free,
 * instant and auditable. This layer adds what rules cannot do - reading across
 * unrelated stories and judging what they mean for a Cambodian marketplace.
 *
 * Design constraints:
 *  - One call per daily report, not per article. Workers AI allows 10,000
 *    neurons/day free, so a single bounded call is comfortably inside it.
 *  - The prompt is capped, so a busy day cannot quietly consume the allowance.
 *  - Any failure degrades to the rule engine. The report is never blocked.
 *  - The model returns JSON; if it does not parse, the result is discarded
 *    rather than half-applied.
 */
import type { Env } from "./env.ts";
import type { Article } from "./db.ts";
import type { FxRates } from "./market.ts";
import { formatRate } from "./market.ts";
import { SOURCE_BY_ID } from "./registry.ts";

/**
 * Default model.
 *
 * Llama 3.1 8B Instruct (the obvious first choice) was deprecated on
 * 2026-05-30, so it is not an option. Llama 4 Scout is used because it was
 * verified end-to-end on this task: it returns valid JSON and grounds its
 * recommendations in the supplied signals.
 *
 * Override per deployment with the AI_MODEL var, or per request with
 * /intel?model=... Worth trying: @cf/aisingapore/gemma-sea-lion-v4-27b-it is
 * instruct-tuned for Southeast Asia, which suits a Cambodian audience.
 */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const modelFor = (env: Env): string => {
  const configured = (env.AI_MODEL ?? "").trim();
  return configured || DEFAULT_AI_MODEL;
};

export interface AiOpportunity {
  headline: string;
  evidence: string[];
  customer: string;
  action: string;
  categories: string[];
  urgency: "act today" | "this week" | "watch";
}

export interface AiAnalysis {
  used: boolean;
  reason: string;
  headline: string;
  summary: string;
  opportunities: AiOpportunity[];
  risks: string[];
  tokensIn: number;
  tokensOut: number;
  /** Raw model text, kept only on failure so it can be diagnosed. */
  raw?: string;
}

export const aiDisabled = (env: Env): boolean =>
  (env.AI_ANALYSIS ?? "1").trim() === "0" || !env.AI;

const maxChars = (env: Env): number => {
  const n = Number(env.AI_MAX_INPUT_CHARS ?? 6000);
  return Number.isFinite(n) && n > 500 ? Math.min(n, 12000) : 6000;
};

/** Compact the day into a bounded briefing for the model. */
export function buildBriefing(rows: Article[], fx: FxRates | null, limit: number): string {
  const lines: string[] = [];
  for (const a of rows.slice(0, limit)) {
    const src = SOURCE_BY_ID[a.source];
    const section = src?.section ?? "cambodia";
    lines.push(`- [${section}/${a.category}] ${a.title} (${a.source})`);
  }
  const rates = fx
    ? `\nFX: USD/KHR ${formatRate("KHR", fx)}  USD/THB ${formatRate("THB", fx)}  USD/CNY ${formatRate("CNY", fx)}  USD/VND ${formatRate("VND", fx)}`
    : "";
  return lines.join("\n") + rates;
}

const SYSTEM = `You are the business analyst for Khmer24, a Cambodian classifieds marketplace
(Job, Marketplace, Auto, Property and Business categories).

You will be given today's news signals and exchange rates. Your job is to judge
what they mean commercially for a Cambodian classifieds platform.

Rules:
- Reply with ONLY a JSON object, no prose, no markdown fences.
- Ground every claim in a supplied signal. Never invent a number, company or event.
- If the signals do not support an opportunity, return fewer, not weaker, ones.
- Be concrete: name the customer type and the action, not generalities.
- Use the exact urgency values: "act today", "this week", "watch".
- Use only these category values: Investment, Jobs & Hiring, Property, Auto,
  Marketplace, Banking, Technology & AI, Cambodia Economy,
  Government & Regulation, Tourism.
- Do not explain your reasoning and do not write anything before the JSON. The
  first characters of your reply must be { and the last must be }.

JSON shape:
{
  "headline": "one sentence describing the most important thing happening",
  "summary": "3-4 sentences a business owner would act on",
  "risks": ["risk 1", "risk 2"],
  "opportunities": [
    {
      "headline": "short label",
      "evidence": ["the exact signal title that supports this"],
      "customer": "which customer type is affected",
      "action": "what Khmer24 should concretely do",
      "categories": ["Marketplace"],
      "urgency": "act today"
    }
  ]
}`;

/**
 * Workers AI models disagree wildly on the response shape. Observed in
 * practice: a plain string, an array of content blocks, `content` as a *nested*
 * array of blocks, and reasoning models that split output across several
 * fields. Walk it rather than guessing one field name.
 */
export function normaliseModelText(raw: unknown, depth = 0): string {
  if (raw === null || raw === undefined || depth > 6) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return "";

  if (Array.isArray(raw)) {
    return raw.map((p) => normaliseModelText(p, depth + 1)).filter(Boolean).join("");
  }

  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["response", "text", "content", "output_text", "delta"]) {
      if (key in o) {
        const v = normaliseModelText(o[key], depth + 1);
        if (v.trim()) return v;
      }
    }
    if (Array.isArray(o.choices)) return normaliseModelText(o.choices, depth + 1);
    if (o.message) return normaliseModelText(o.message, depth + 1);
    return "";
  }
  return "";
}

/**
 * Extract the outermost balanced JSON object from a model response.
 *
 * Naive "first { to last }" or "last { to next }" both fail on nested objects:
 * a forward scan stops at an inner brace, and a reverse scan happily matches a
 * single nested item and silently loses the rest of the document. This walks
 * the string, tracking depth and string state, and returns the complete object.
 */
export function extractJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue; // stray closing brace before any opening
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  // Unterminated object: salvage what was completed. Model output is routinely
  // cut off by max_tokens, so recovery has to close the open containers in the
  // right order - appending a lone "}" to '{"o":[{"a":1' is still invalid JSON.
  if (start !== -1 && depth > 0) {
    const partial = text.slice(start);
    const cut = lastSafeCut(partial);
    if (cut > 0) {
      const salvaged = closeContainers(partial.slice(0, cut));
      if (salvaged) return salvaged;
    }
  }
  return null;
}

/** Index of the last complete value or member separator, ignoring strings. */
function lastSafeCut(partial: string): number {
  let inString = false;
  let escaped = false;
  let best = -1;
  for (let i = 0; i < partial.length; i++) {
    const ch = partial[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "}" || ch === "]" || ch === ",") best = i;
  }
  return best;
}

/** Append the closers needed to balance a truncated JSON fragment. */
function closeContainers(partial: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < partial.length; i++) {
    const ch = partial[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) return null; // a dangling string cannot be recovered
  const out = partial.replace(/[,:\s]+$/, "");
  if (!out) return null;
  let closed = out;
  for (let i = stack.length - 1; i >= 0; i--) closed += stack[i];
  return closed;
}

/** Pull the JSON object out of a model response and normalise its fields. */
export function parseAnalysis(text: string): Omit<AiAnalysis, "used" | "reason" | "tokensIn" | "tokensOut"> | null {
  if (!text) return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidate = fence[1].trim();

  const json = extractJsonObject(candidate);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return normaliseFields(parsed);
  } catch {
    return null;
  }
}

function normaliseFields(parsed: Record<string, unknown>): Omit<
  AiAnalysis, "used" | "reason" | "tokensIn" | "tokensOut"
> {
  const validCategories = new Set([
    "Investment", "Jobs & Hiring", "Property", "Auto", "Marketplace",
    "Banking", "Technology & AI", "Cambodia Economy",
    "Government & Regulation", "Tourism",
  ]);
  const validUrgency = new Set(["act today", "this week", "watch"]);

  const opps = Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  const opportunities: AiOpportunity[] = opps
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .map((o) => ({
      headline: String(o.headline ?? "").slice(0, 140),
      evidence: Array.isArray(o.evidence)
        ? o.evidence.map((e) => String(e).slice(0, 160)).slice(0, 3)
        : [],
      customer: String(o.customer ?? "").slice(0, 220),
      action: String(o.action ?? "").slice(0, 300),
      categories: Array.isArray(o.categories)
        ? o.categories.map((c) => String(c)).filter((c) => validCategories.has(c)).slice(0, 3)
        : [],
      urgency: (validUrgency.has(String(o.urgency)) ? String(o.urgency) : "watch") as
        AiOpportunity["urgency"],
    }))
    // An opportunity with no evidence and no action is noise; drop it.
    .filter((o) => o.headline.length > 3 && (o.evidence.length > 0 || o.action.length > 15))
    .slice(0, 6);

  const headline = String(parsed.headline ?? "").slice(0, 200);
  const summary = String(parsed.summary ?? "").slice(0, 900);
  const risks = Array.isArray(parsed.risks)
    ? parsed.risks.map((r) => String(r).slice(0, 200)).filter(Boolean).slice(0, 4)
    : [];

  // An all-empty object is a failed generation, not a valid empty analysis.
  // Returning it would report the AI as "used" while contributing nothing.
  if (!summary && opportunities.length === 0) return null as never;

  return { headline, summary, risks, opportunities };
}

export async function runAnalyst(
  env: Env,
  rows: Article[],
  fx: FxRates | null,
): Promise<AiAnalysis> {
  const empty: AiAnalysis = {
    used: false, reason: "", headline: "", summary: "", opportunities: [],
    risks: [], tokensIn: 0, tokensOut: 0,
  };
  if (aiDisabled(env)) return { ...empty, reason: "AI disabled" };
  if (!env.AI) return { ...empty, reason: "no AI binding" };
  if (rows.length === 0) return { ...empty, reason: "no signals" };

  const briefing = buildBriefing(rows, fx, 40).slice(0, maxChars(env));
  try {
    const res = await env.AI.run(modelFor(env), {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Today's signals:\n${briefing}` },
      ],
      // Bounded so one report cannot consume the daily allowance, but high
      // enough that a reasoning model's preamble does not truncate the JSON.
      max_tokens: 2600,
      temperature: 0.3,
    });

    const response = res as {
      response?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Normalise the whole result, not just `.response`: depending on the model
    // the text sits at res.response, res.content, res.choices[0] and so on, and
    // walking the object handles every shape.
    const rawText = normaliseModelText(res);
    const parsed = parseAnalysis(rawText);
    if (!parsed) {
      // Keep the raw text so the failure can be diagnosed instead of guessed at.
      return {
        ...empty,
        reason: "model output was not valid JSON",
        raw: rawText.slice(0, 4000),
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
      };
    }
    return {
      used: true,
      reason: "ok",
      ...parsed,
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    // Quota, model unavailability, timeout: the rule engine still runs.
    return { ...empty, reason: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 200) };
  }
}
