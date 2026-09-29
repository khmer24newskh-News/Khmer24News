/**
 * Test the Worker's real Telegram code against the live Bot API.
 *
 * Credentials are read from the existing .env at runtime and held in memory only -
 * nothing is written to disk, and the token is never printed.
 *
 * Run: node --experimental-strip-types test/telegram-live.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dotenv } from "./dotenv-lite.ts";
import { telegramCheck, sendTelegram, telegramConfigured } from "../src/telegram.ts";
import type { Env } from "../src/env.ts";

/**
 * Locate the project .env without hardcoding an absolute path, so this works
 * for anyone who clones the repo. Override with KHMER24_ENV=/path/to/.env
 */
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.KHMER24_ENV,
  resolve(here, "..", "..", ".env"),
  resolve(here, "..", ".env"),
].filter((p): p is string => Boolean(p));
const dotenvPath = candidates.find((p) => existsSync(p));

if (!dotenvPath) {
  console.error(`No .env found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}`);
  console.error("Copy .env.example to .env, or set KHMER24_ENV to point at one.");
  process.exit(2);
}
console.log(`using ${dotenvPath}`);
const values = dotenv(readFileSync(dotenvPath, "utf8"));

const mask = (s: string) => (s.length <= 10 ? "*".repeat(s.length) : `${s.slice(0, 6)}******${s.slice(-4)}`);

const env = {
  DB: null as unknown as D1Database,
  TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: values.TELEGRAM_CHAT_ID,
} satisfies Env;

console.log("=== credentials loaded from .env (masked, never printed) ===");
console.log(`  TELEGRAM_BOT_TOKEN : ${mask(env.TELEGRAM_BOT_TOKEN ?? "")}`);
console.log(`  TELEGRAM_CHAT_ID   : ${env.TELEGRAM_CHAT_ID}`);
console.log(`  telegramConfigured : ${telegramConfigured(env)}`);

let failures = 0;
const expect = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!cond) failures++;
};

console.log("\n=== 1. telegramCheck() - read-only, sends nothing ===");
const lines = await telegramCheck(env);
for (const l of lines) console.log(`  [${l.ok ? "x" : " "}] ${l.text}`);
expect("token valid", lines.some((l) => l.ok && l.text.includes("Token valid")));
expect("chat reachable", lines.some((l) => l.ok && l.text.includes("Chat reachable")));

console.log("\n=== 2. sendTelegram() rejects bad input before any network call ===");
const empty = await sendTelegram({ ...env, TELEGRAM_BOT_TOKEN: "" }, "hi");
expect("empty token rejected", !empty.ok && empty.detail.includes("not configured"), empty.detail.slice(0, 60));
const placeholder = await sendTelegram({ ...env, TELEGRAM_TOKEN_PLACEHOLDER: undefined, TELEGRAM_BOT_TOKEN: "PUT_YOUR_BOT_TOKEN_HERE" } as Env, "hi");
expect("placeholder token rejected", !placeholder.ok && placeholder.detail.includes("not configured"));
const tooLong = await sendTelegram(env, "x".repeat(5000));
expect("oversized message rejected", !tooLong.ok && tooLong.detail.includes("4096"), tooLong.detail.slice(0, 60));

console.log("\n=== 3. sendTelegram() with a BAD token (expect a clean error, no crash) ===");
const badToken = await sendTelegram(
  { ...env, TELEGRAM_BOT_TOKEN: "123456:AAFakeTokenThatDoesNotExistAtAll000" },
  "should not send",
);
expect("bad token fails cleanly", !badToken.ok, `detail: ${badToken.detail.slice(0, 80)}`);
expect("bad token error mentions Telegram", badToken.detail.includes("Telegram error"), badToken.detail.slice(0, 80));

console.log("\n=== 4. sendTelegram() with a BAD chat id (expect 'chat not found') ===");
const badChat = await sendTelegram({ ...env, TELEGRAM_CHAT_ID: "-1000000000000" }, "should not send");
expect("bad chat fails cleanly", !badChat.ok, `detail: ${badChat.detail.slice(0, 90)}`);

console.log("\n=== 5. sendTelegram() for real ===");
const realText =
  "\u{1F1F0}\u{1F1ED} KHMER24 DAILY BUSINESS INTELLIGENCE\n" +
  `\u{1F4C5} ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Phnom_Penh" })}\n\n` +
  "\u{1F9EA} Worker integration test\n\n" +
  "The Cloudflare Worker's Telegram code just sent this through the real Bot API.\n" +
  "If you can read it, the deploy path is verified end to end.";

const sent = await sendTelegram(env, realText);
console.log(`  result : ${sent.ok ? "OK" : "FAILED"}`);
console.log(`  detail : ${sent.detail}`);
expect("real message delivered", sent.ok, sent.detail);

console.log(`\n${"=".repeat(56)}`);
if (failures === 0) {
  console.log("  all green - the Worker's Telegram code works against the live Bot API");
} else {
  console.log(`  ${failures} failure(s)`);
  process.exit(1);
}
