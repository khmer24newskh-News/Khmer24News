/**
 * Manus API client.
 *
 * Manus is an asynchronous agent: a task is created, it runs for minutes, and
 * the result is read back from its message log. That shape matters here because
 * a Cloudflare Worker cannot hold a request open for the length of an agent run,
 * so nothing in this file waits indefinitely. `startTask` returns immediately,
 * and `pollTask` reads one snapshot. Anything that needs to wait says so.
 *
 * Verified against https://open.manus.ai/docs/v2 (task.create, task.detail,
 * task.listMessages). Field names below are the API's, not renamed, so the code
 * can be read next to the docs.
 */

import type { Env } from "./env.ts";

const DEFAULT_BASE = "https://api.manus.ai";

/** Agent profiles the menu offers. The API accepts more; these are the stable three. */
export const MANUS_PROFILES = ["standard", "lite", "max"] as const;
export type ManusProfile = (typeof MANUS_PROFILES)[number];

/** The `ok:false` body the API returns on a rejected call. */
interface ManusErrorBody {
  ok?: false;
  request_id?: string;
  error?: { code?: string; message?: string };
}

export interface ManusTask {
  id: string;
  status: "running" | "stopped" | "waiting" | "error" | "deleted";
  title?: string;
  task_url?: string;
  created_at?: number;
  updated_at?: number;
  has_running_background_jobs?: boolean;
}

export interface ManusMessage {
  id: string;
  type: string;
  timestamp?: number;
  user_message?: { content?: string };
  assistant_message?: { content?: string; delivery_kind?: string };
  error_message?: { error_type?: string; content?: string };
  status_update?: {
    agent_status?: string;
    brief?: string;
    description?: string;
    status_detail?: { waiting_description?: string; waiting_for_event_type?: string };
  };
  structured_output_result?: { success?: boolean; value?: unknown; error?: string | null };
}

export interface ManusCreateResult {
  ok: boolean;
  taskId: string;
  taskUrl: string;
  title: string;
  error: string | null;
}

export interface ManusSnapshot {
  ok: boolean;
  task: ManusTask | null;
  messages: ManusMessage[];
  /** The agent's final answer, if it has produced one. */
  text: string;
  error: string | null;
}

/** True when the account has a key and has not switched Manus off. */
export function manusConfigured(env: Env): boolean {
  if (!env.MANUS_API_KEY) return false;
  // A master switch, so the key can stay installed while the feature is off.
  const enabled = (env.MANUS_ENABLED ?? "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(enabled);
}

function baseUrl(env: Env): string {
  return (env.MANUS_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function authHeaders(env: Env): Record<string, string> {
  // The API documents x-manus-api-key; sending Authorization as well is an
  // error ("provide either this or Authorization, not both").
  return { "Content-Type": "application/json", "x-manus-api-key": env.MANUS_API_KEY ?? "" };
}

/** Turn an HTTP failure into something worth showing a person. */
async function describeFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as ManusErrorBody;
    const code = body.error?.code ?? "";
    const message = body.error?.message ?? "";
    detail = [code, message].filter(Boolean).join(": ");
    if (body.request_id) detail += ` (request ${body.request_id})`;
  } catch {
    /* non-JSON body */
  }
  if (!detail) {
    const text = await res.text().catch(() => "");
    detail = text.slice(0, 200) || res.statusText;
  }
  return `HTTP ${res.status} ${detail}`.trim();
}

/**
 * Create a task. Returns as soon as the agent has accepted the work, which is
 * typically a second or two - not when the work is finished.
 */
export async function startTask(
  env: Env,
  prompt: string,
  opts: { profile?: ManusProfile; title?: string; locale?: string } = {},
): Promise<ManusCreateResult> {
  const failed = (error: string): ManusCreateResult => ({
    ok: false, taskId: "", taskUrl: "", title: "", error,
  });

  if (!manusConfigured(env)) return failed("Manus is not configured");
  const text = prompt.trim();
  if (!text) return failed("Refusing to create a task with an empty prompt");

  const body: Record<string, unknown> = {
    message: { content: text },
    // Keep a task run from drifting into a question the Worker cannot answer.
    interactive_mode: false,
  };
  if (opts.profile) body.agent_profile = opts.profile;
  if (opts.title) body.title = opts.title;
  if (opts.locale) body.locale = opts.locale;

  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}/v2/task.create`, {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return failed(`${(err as Error).name}: ${(err as Error).message}`);
  }

  if (!res.ok) return failed(await describeFailure(res));

  let data: { ok?: boolean; task_id?: string; task_url?: string; task_title?: string } & ManusErrorBody;
  try {
    data = await res.json();
  } catch (err) {
    return failed(`unreadable response: ${(err as Error).message}`);
  }
  if (!data.ok || !data.task_id) {
    const why = data.error?.message ?? "no task_id in the response";
    return failed(why);
  }
  return {
    ok: true,
    taskId: data.task_id,
    taskUrl: data.task_url ?? "",
    title: data.task_title ?? "",
    error: null,
  };
}

/** One status read. Does not wait. */
export async function getTask(env: Env, taskId: string): Promise<{ task: ManusTask | null; error: string | null }> {
  if (!manusConfigured(env)) return { task: null, error: "Manus is not configured" };
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}/v2/task.detail?task_id=${encodeURIComponent(taskId)}`, {
      headers: authHeaders(env),
    });
  } catch (err) {
    return { task: null, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
  if (!res.ok) return { task: null, error: await describeFailure(res) };
  try {
    const data = (await res.json()) as { ok?: boolean; task?: ManusTask } & ManusErrorBody;
    if (!data.ok || !data.task) {
      return { task: null, error: data.error?.message ?? "no task in the response" };
    }
    return { task: data.task, error: null };
  } catch (err) {
    return { task: null, error: `unreadable response: ${(err as Error).message}` };
  }
}

/** The message log, oldest last, so the final answer is at the end. */
export async function listMessages(
  env: Env,
  taskId: string,
  opts: { limit?: number } = {},
): Promise<{ messages: ManusMessage[]; error: string | null }> {
  if (!manusConfigured(env)) return { messages: [], error: "Manus is not configured" };
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const url = `${baseUrl(env)}/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}` +
    `&order=asc&limit=${limit}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(env) });
  } catch (err) {
    return { messages: [], error: `${(err as Error).name}: ${(err as Error).message}` };
  }
  if (!res.ok) return { messages: [], error: await describeFailure(res) };
  try {
    const data = (await res.json()) as { ok?: boolean; messages?: ManusMessage[] } & ManusErrorBody;
    if (!data.ok) return { messages: [], error: data.error?.message ?? "listMessages was refused" };
    return { messages: data.messages ?? [], error: null };
  } catch (err) {
    return { messages: [], error: `unreadable response: ${(err as Error).message}` };
  }
}

/**
 * The agent's answer, as distinct from its running commentary.
 *
 * Manus streams progress into the same log, so "the last assistant message" is
 * often "I'm opening the browser" rather than a result. Prefer the message
 * marked `delivery_kind: "result"`, then any message that is not progress, and
 * only then the final message.
 */
export function extractResultText(messages: ManusMessage[]): string {
  const withText = messages.filter((m) => m.type === "assistant_message" && m.assistant_message?.content?.trim());
  if (withText.length === 0) return "";
  const results = withText.filter((m) => m.assistant_message?.delivery_kind === "result");
  if (results.length) return results[results.length - 1]!.assistant_message!.content!.trim();
  const notProgress = withText.filter((m) => m.assistant_message?.delivery_kind !== "progress");
  if (notProgress.length) return notProgress[notProgress.length - 1]!.assistant_message!.content!.trim();
  return withText[withText.length - 1]!.assistant_message!.content!.trim();
}

/** The most recent error the agent reported, if any. */
export function extractError(messages: ManusMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "error_message" && m.error_message?.content) {
      return m.error_message.content;
    }
  }
  return null;
}

/** One read of everything needed to decide what to do next. */
export async function pollTask(env: Env, taskId: string): Promise<ManusSnapshot> {
  const detail = await getTask(env, taskId);
  if (!detail.task) {
    return { ok: false, task: null, messages: [], text: "", error: detail.error };
  }
  // A finished task's messages are the only reason to read them, but a running
  // task's progress is useful for the status view, so read either way.
  const log = await listMessages(env, taskId, { limit: 100 });
  return {
    ok: log.error === null,
    task: detail.task,
    messages: log.messages,
    text: extractResultText(log.messages),
    error: log.error ?? extractError(log.messages),
  };
}

export interface ManusWaitResult extends ManusSnapshot {
  /** True when the agent reached a terminal state inside the wait. */
  settled: boolean;
}

/**
 * Poll until the task settles, or until the wait runs out.
 *
 * Bounded on purpose: a Worker has a wall-clock limit and a task can run for
 * many minutes. `settled: false` is a normal outcome, not an error - the caller
 * should report the task URL and stop, rather than pretend the run failed.
 */
export async function awaitTask(
  env: Env,
  taskId: string,
  opts: { maxWaitMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ManusWaitResult> {
  const maxWaitMs = opts.maxWaitMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 2_500;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + maxWaitMs;

  let snapshot = await pollTask(env, taskId);
  for (;;) {
    const status = snapshot.task?.status;
    const terminal = status === "stopped" || status === "error" || status === "deleted";
    // A stopped task with background work still running may add more later, but
    // it has already produced an answer, which is what the caller wants.
    if (terminal) return { ...snapshot, settled: true };
    if (now() >= deadline) return { ...snapshot, settled: false };
    await sleep(intervalMs);
    snapshot = await pollTask(env, taskId);
  }
}
