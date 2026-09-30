/**
 * Telegram menu: choose your brief from inside Telegram.
 *
 * The dashboard at /settings is the full-fat editor. This is the on-the-go
 * version - tick the sections you care about straight from the chat. Both write
 * to the same D1 preferences, so a change here is immediately reflected on the
 * dashboard and in the 07:30 send.
 */
import { applyPrefs, filterRows, loadPrefs, savePrefs, ALL_SECTIONS, URGENCIES, type Prefs, type Urgency } from "./prefs.ts";
import { SECTION_META, type Section } from "./registry.ts";
import { getArticles } from "./db.ts";
import { fetchFxRates } from "./market.ts";
import { buildIntelReport, renderIntelMessages, applyAnalysis, type IntelReport } from "./intel.ts";
import { TELEGRAM_MAX_LEN } from "./config.ts";
import { runAnalyst } from "./analyst.ts";
import type { Env } from "./env.ts";

export const MENU_PREFIX = "kb24";

/** Send a message with an inline keyboard. */
export async function sendWithMenu(
  env: Env,
  chatId: string,
  text: string,
  keyboard: unknown,
): Promise<{ ok: boolean; detail: string }> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return { ok: false, detail: "Telegram not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    return data.ok
      ? { ok: true, detail: "menu sent" }
      : { ok: false, detail: data.description ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

export async function editMessageText(
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
  keyboard: unknown,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId, message_id: messageId, text,
          disable_web_page_preview: true, reply_markup: keyboard,
        }),
      },
    );
    const data = (await res.json()) as { ok?: boolean; description?: string };
    return data.ok
      ? { ok: true, detail: "menu updated" }
      : { ok: false, detail: data.description ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

const mark = (on: boolean) => (on ? "✅" : "⬜️");
const urgencyIcon: Record<Urgency, string> = { "act today": "\u{1F525}", "this week": "\u{1F4CC}", watch: "\u{1F440}" };

/**
 * Section buttons.
 *
 * Money and Opportunities cannot be turned off, but their buttons still carry
 * their real callback so the tap answers with an explanation instead of
 * silently doing nothing.
 */
/**
 * Section buttons on the main menu.
 *
 * These open the section rather than toggling it. Reading and switching are
 * different intentions, and a button that only flips a flag gives you nothing to
 * decide with. The tick still says whether the section reaches the daily brief,
 * and the toggle itself lives in the section view, where you have just read the
 * stories.
 */
function sectionButtons(prefs: Prefs): unknown[] {
  const rows: unknown[] = [];
  for (const s of ALL_SECTIONS) {
    const locked = s === "money" || s === "opportunity";
    const on = prefs.sections.includes(s);
    const m = SECTION_META[s];
    rows.push([
      {
        text: locked ? `${m.emoji} ${m.title} (always in)` : `${mark(on)} ${m.emoji} ${m.title}`,
        callback_data: `${MENU_PREFIX}:see:${s}`,
      },
    ]);
  }
  return rows;
}

export function buildKeyboard(prefs: Prefs): unknown {
  return {
    inline_keyboard: [
      ...sectionButtons(prefs),
      [
        {
          text: `Urgency: ${urgencyIcon[prefs.minUrgency]} ${prefs.minUrgency}`,
          callback_data: `${MENU_PREFIX}:urg`,
        },
        { text: `AI: ${prefs.ai ? "on" : "off"}`, callback_data: `${MENU_PREFIX}:ai` },
      ],
      [
        { text: "\u{1F4E4} Send my brief now", callback_data: `${MENU_PREFIX}:send` },
        { text: "\u{1F4CA} Status", callback_data: `${MENU_PREFIX}:status` },
      ],
      [
        { text: "\u{1F4CB} See a section now", callback_data: `${MENU_PREFIX}:browse` },
      ],
      [
        { text: "\u{1F310} Full settings in the dashboard", url: "" },
        { text: "Hide", callback_data: `${MENU_PREFIX}:close` },
      ],
    ],
  };
}

/** With the dashboard link filled in, so the button is usable. */
export function buildKeyboardWithUrl(prefs: Prefs, settingsUrl: string): unknown {
  const kb = buildKeyboard(prefs) as { inline_keyboard: unknown[][] };
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1]!;
  last[0] = { text: "\u{1F310} Full settings in the dashboard", url: settingsUrl };
  return kb;
}

export function menuCaption(prefs: Prefs): string {
  const active = ALL_SECTIONS.filter((s) => prefs.sections.includes(s));
  const parts = active.map((s) => SECTION_META[s].title);
  return [
    "\u{1F1F0}\u{1F1ED} What do you want to know?",
    "",
    `Watching: ${parts.join(", ") || "nothing yet"}`,
    `Urgency: ${prefs.minUrgency}   AI analyst: ${prefs.ai ? "on" : "off"}`,
    `Window: last ${prefs.hours}h`,
    "",
    "Tap a section to switch it on or off. Your 07:30 brief follows these settings.",
  ].join("\n");
}

/**
 * Apply one tap: load, change, persist, and report what happened.
 *
 * Persistence lives here rather than in the route so that a tap is atomic and
 * testable on its own. `changed` is false when the tap was a no-op, in which
 * case nothing is written.
 */
export async function handleToggle(
  db: D1Database,
  data: string,
): Promise<{ prefs: Prefs; note: string; changed: boolean }> {
  const prefs = await loadPrefs(db);
  const [, action, arg] = data.split(":");
  let note = "";
  let changed = false;

  switch (action) {
    // "toggle" is the current name. "sec" is still accepted because keyboards
    // rendered before the change are sitting in people's chats, and a stale
    // button that does nothing looks like a broken bot.
    case "toggle":
    case "sec": {
      const section = arg as Section;
      if (!(section in SECTION_META)) return { prefs, note: "", changed: false };
      if (section === "money" || section === "opportunity") {
        return { prefs, note: `${SECTION_META[section].title} is part of every brief.`, changed: false };
      }
      const on = prefs.sections.includes(section);
      const kept = on ? prefs.sections.filter((s) => s !== section) : [...prefs.sections, section];
      if (kept.length === 0) {
        // Should not be reachable, because money and opportunity are locked on,
        // but an empty brief is worse than a slightly wrong one.
        prefs.sections = ["money", "opportunity"];
        return { prefs, note: "At least Money and Opportunities are always included.", changed: true };
      }
      prefs.sections = kept;
      changed = true;
      note = `${SECTION_META[section].emoji} ${SECTION_META[section].title} ${on ? "off" : "on"}`;
      break;
    }
    case "urg": {
      prefs.minUrgency = URGENCIES[(URGENCIES.indexOf(prefs.minUrgency) + 1) % URGENCIES.length]!;
      changed = true;
      note = `Urgency: ${prefs.minUrgency}`;
      break;
    }
    case "ai": {
      prefs.ai = !prefs.ai;
      changed = true;
      note = `AI analyst ${prefs.ai ? "on" : "off"}`;
      break;
    }
    default:
      // `send` and `close` are handled by the route because they need effects
      // beyond preferences. An unknown or stale tap just re-renders.
      return { prefs, note: "", changed: false };
  }

  await savePrefs(db, prefs);
  return { prefs, note, changed };
}

/** Callback payloads that the route must act on itself rather than as a toggle. */
export const CLOSE = `${MENU_PREFIX}:close`;
export const SEND_NOW = `${MENU_PREFIX}:send`;
/** An empty keyboard removes the buttons, which is how Hide works. */
export const NO_KEYBOARD = { inline_keyboard: [] as unknown[] };

/** Build and send the brief right now, using current preferences. */
export async function buildAndSendBrief(env: Env): Promise<{ messages: number; opportunities: number; error: string | null }> {
  const prefs = await loadPrefs(env.DB);
  const all = await getArticles(env.DB, { limit: 200, hours: prefs.hours });
  const rows = filterRows(all, prefs);
  const fx = await fetchFxRates();
  let report = buildIntelReport(rows, fx, []);
  if (prefs.ai) {
    const ai = await runAnalyst(env, rows, fx);
    applyAnalysis(report, ai);
  }
  report = applyPrefs(report, prefs);

  const messages = renderIntelMessages(report);
  let sent = 0;
  for (const text of messages) {
    const r = await sendTelegramPlain(env, text);
    if (!r.ok) return { messages: sent, opportunities: report.opportunities.length, error: r.detail };
    sent++;
  }
  return { messages: sent, opportunities: report.opportunities.length, error: null };
}


async function sendTelegramPlain(env: Env, text: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string; result?: { chat?: { title?: string } } };
    return data.ok
      ? { ok: true, detail: `Delivered to ${data.result?.chat?.title ?? env.TELEGRAM_CHAT_ID}` }
      : { ok: false, detail: data.description ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

/** Register the webhook so Telegram can reach the Worker. */
export async function setWebhook(env: Env, webhookUrl: string, secret: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ["message", "callback_query"] }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string; result?: unknown };
    return data.ok
      ? { ok: true, detail: `webhook set to ${webhookUrl}` }
      : { ok: false, detail: data.description ?? "unknown error" };
  } catch (err) {
    return { ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

export async function webhookInfo(env: Env): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, description: `${(err as Error).name}` };
  }
}

// ---------------------------------------------------------------------------
// Browsing: see one section's content on demand
// ---------------------------------------------------------------------------

/** Callback payload for "show me this section". */
export const SECTION_PREFIX = `${MENU_PREFIX}:see:`;

/**
 * Every section, as a picker.
 *
 * The toggle keyboard controls what reaches the daily brief. This is the other
 * half: tapping a section here shows what is in it *right now*, whether or not
 * it is switched on for the brief. Being able to look at one thing without
 * rewriting the whole brief is the point.
 */
export function buildSectionPicker(prefs: Prefs): unknown {
  return {
    inline_keyboard: [
      ...ALL_SECTIONS.map((s) => {
        const m = SECTION_META[s];
        const on = prefs.sections.includes(s);
        return [
          {
            text: `${on ? "\u{2705}" : "\u{2B1C}"} ${m.emoji} ${m.title}`,
            callback_data: `${SECTION_PREFIX}${s}`,
          },
        ];
      }),
      [{ text: "\u{1F519} Back to menu", callback_data: `${MENU_PREFIX}:back` }],
    ],
  };
}

/**
 * Keyboard under a section.
 *
 * The toggle sits here rather than on the main menu because this is where the
 * decision makes sense: you have read the stories, so you know.
 */
export function buildSectionFooter(section: Section, inBrief: boolean): unknown {
  const locked = section === "money" || section === "opportunity";
  const rows: unknown[][] = [];
  if (!locked) {
    rows.push([
      {
        text: inBrief
          ? "\u{2796} Remove from my 07:30 brief"
          : "\u{2795} Add to my 07:30 brief",
        callback_data: `${MENU_PREFIX}:toggle:${section}`,
      },
    ]);
  }
  rows.push([
    { text: "\u{1F4CB} Another section", callback_data: `${MENU_PREFIX}:browse` },
    { text: "\u{1F4E4} Full brief", callback_data: `${MENU_PREFIX}:send` },
  ]);
  rows.push([{ text: "\u{1F519} Back to menu", callback_data: `${MENU_PREFIX}:back` }]);
  return { inline_keyboard: rows };
}

/**
 * Render one section for reading.
 *
 * Preferences are not applied to the content, only used to choose the window and
 * the sources. Asking to see a section you switched off must show it rather than
 * quietly return nothing, which would be indistinguishable from an empty section.
 */
export function renderSectionView(
  report: IntelReport,
  sectionKey: Section,
  briefCount?: number,
  inBrief?: boolean,
): string {
  const block = report.sections.find((s) => s.section === sectionKey);
  const meta = SECTION_META[sectionKey];
  if (!block) return `${meta.emoji} ${meta.title}\n\nNot available.`;
  const head = [`${meta.emoji} ${meta.title}`];
  // Say where this sits, so the reader knows what the toggle below will do.
  if (typeof briefCount === "number" && typeof inBrief === "boolean") {
    head.push(inBrief ? `In your 07:30 brief (${briefCount} sections on)` : "Not in your 07:30 brief");
  }
  if (block.empty) return [...head, "", "Nothing in this section right now.", ""].join("\n");
  return [...head, "", ...block.lines].join("\n").slice(0, TELEGRAM_MAX_LEN);
}
