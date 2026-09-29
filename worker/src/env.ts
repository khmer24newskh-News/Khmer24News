/**
 * Worker bindings and environment configuration.
 *
 * Secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ADMIN_TOKEN) are set with
 *   npx wrangler secret put <NAME>
 * and must NOT go in wrangler.toml, which is committed to git.
 *
 * Plain settings (LOOKBACK_HOURS etc.) live in [vars] in wrangler.toml.
 */
export interface Env {
  /** D1 database binding. */
  DB: D1Database;
  /**
   * Workers AI binding. Declared as optional so the Worker still type-checks and
   * runs locally without it; runAnalyst() checks before use.
   */
  AI?: Ai;
  /** Override the analysis model, e.g. @cf/aisingapore/gemma-sea-lion-v4-27b-it */
  AI_MODEL?: string;
  /** Set to "0" to disable the AI analysis pass. */
  AI_ANALYSIS?: string;
  /** Caps the prompt size so one run cannot blow the daily neuron allowance. */
  AI_MAX_INPUT_CHARS?: string;
  /** @secret */
  TELEGRAM_BOT_TOKEN?: string;
  /** @secret */
  TELEGRAM_CHAT_ID?: string;
  /**
   * @secret Required by /collect, /send, /run and /api/articles.
   * Without it those endpoints are closed, so a stranger cannot use your bot.
   */
  ADMIN_TOKEN?: string;
  LOOKBACK_HOURS?: string;
  MAX_ITEMS_PER_SOURCE?: string;
  MAX_RESOLVES?: string;
  DUP_OVERLAP?: string;
  PURGE_AFTER_DAYS?: string;
  /** Send each article as its source publishes it. */
  STREAM_ALERTS?: string;
  /** Articles per alert message. */
  ALERT_BATCH_SIZE?: string;
  /** Cap per cron tick, so a bulk upload cannot flood the chat. */
  ALERT_MAX_PER_TICK?: string;
  /** Send the daily digest on the 07:30 run. */
  DAILY_DIGEST?: string;
  /** @secret Shared with Telegram so only Telegram can drive the bot webhook. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * "push" (default) = articles arrive via POST /ingest from the local fetcher.
   * "poll" = the Worker tries to fetch feeds itself, which does NOT work from
   * Cloudflare because Google News answers datacenter IPs with 503. Kept only
   * for reference and for any future non-Google discovery path.
   */
  DISCOVERY_MODE?: string;
}
