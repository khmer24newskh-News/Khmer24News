/**
 * Telegram delivery. Workers uses global `fetch`, so there is no requests equivalent.
 */
import { REQUEST_TIMEOUT_MS, TELEGRAM_MAX_LEN } from "./config.ts";
import type { Env } from "./env.ts";

export interface SendResult {
  ok: boolean;
  detail: string;
}

const isPlaceholder = (v: string | undefined): boolean =>
  !v || v.startsWith("PUT_") || v.includes("YOUR_");

export function telegramConfigured(env: Env): boolean {
  return !isPlaceholder(env.TELEGRAM_BOT_TOKEN) && !isPlaceholder(env.TELEGRAM_CHAT_ID);
}

async function apiCall(
  env: Env,
  method: "getMe" | "getChat" | "sendMessage",
  extra: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: method === "sendMessage" ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: method === "sendMessage" ? JSON.stringify(extra) : undefined,
      signal: controller.signal,
    });
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, description: `${(err as Error).name}: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface SendOptions {
  /**
   * Let Telegram render its link preview under the message.
   *
   * Off by default: the daily brief and the compact batch both carry many links
   * and a preview per message is clutter. Breaking cards turn it on, because
   * there is exactly one link and the preview is the point.
   */
  linkPreview?: boolean;
}

export async function sendTelegram(
  env: Env,
  text: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  if (!telegramConfigured(env)) {
    return {
      ok: false,
      detail:
        "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Worker secrets " +
        "(`wrangler secret put TELEGRAM_BOT_TOKEN`), then re-run.",
    };
  }
  if (text.length > TELEGRAM_MAX_LEN) {
    return { ok: false, detail: `Refusing to send: ${text.length} chars exceeds the ${TELEGRAM_MAX_LEN} limit.` };
  }

  const data = await apiCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID!,
    text,
    disable_web_page_preview: opts.linkPreview ? "false" : "true",
  });

  if (data?.ok === true) {
    const result = (data.result ?? {}) as { chat?: { title?: string; username?: string; first_name?: string } };
    const who = result.chat?.title || result.chat?.username || result.chat?.first_name || env.TELEGRAM_CHAT_ID;
    return { ok: true, detail: `Delivered to ${who} (${text.length} chars).` };
  }
  const description = typeof data?.description === "string" ? data.description : JSON.stringify(data);
  return { ok: false, detail: `Telegram error: ${description}` };
}

export interface CheckLine {
  ok: boolean;
  text: string;
}

/** Read-only credential validation. Sends nothing. */
export async function telegramCheck(env: Env): Promise<CheckLine[]> {
  if (!telegramConfigured(env)) {
    return [
      { ok: false, text: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing / still a placeholder." },
      { ok: false, text: "Set both as Worker secrets: wrangler secret put TELEGRAM_BOT_TOKEN" },
    ];
  }
  const lines: CheckLine[] = [];

  const me = await apiCall(env, "getMe");
  if (me?.ok === true) {
    const r = me.result as { username?: string; first_name?: string };
    lines.push({ ok: true, text: `Token valid. Bot: @${r.username} (${r.first_name})` });
  } else {
    lines.push({ ok: false, text: `Token rejected: ${String(me?.description ?? me)}` });
    return lines;
  }

  const chat = await apiCall(env, "getChat", { chat_id: env.TELEGRAM_CHAT_ID! });
  if (chat?.ok === true) {
    const r = chat.result as { title?: string; username?: string; type?: string };
    lines.push({ ok: true, text: `Chat reachable: ${r.title || r.username} (type: ${r.type})` });
  } else {
    lines.push({ ok: false, text: `Chat not found: ${String(chat?.description ?? chat)}` });
    lines.push({ ok: false, text: "Message the bot once, then check again. Groups look like -1001234567890." });
  }
  return lines;
}
