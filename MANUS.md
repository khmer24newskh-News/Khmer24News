# Manus integration

An optional second analyst. **It is off by default and the system works fully
without it.**

The brief already has a free, instant analyst (Workers AI) and a deterministic
rule engine. Manus is different in kind: it is an autonomous agent that browses
the web, runs code and writes files over several minutes, and it spends credits.
That makes it good at exactly one job here — *"given all of today's signals, what
should Khmer24 do next week?"* — and wasteful at per-article summarising, which
the rules already do for free.

So Manus is **on demand**, never in the automatic path. The daily brief never
waits for it.

## Turning it on

Two steps, because either one alone should not start spending money.

1. Install the key:
   ```powershell
   cd worker
   npx wrangler secret put MANUS_API_KEY
   ```
2. Switch it on, either place:
   - Web: `/settings?key=ADMIN_TOKEN` → **Manus agent (deep analysis)** → tick → pick a profile → save
   - Telegram: `/menu` → **🧠 Manus deep analysis: off** → tap

Turning it on adds **🧠 Deep analysis with Manus** to the Telegram menu.

To stop spending without deleting the key, set `MANUS_ENABLED = "0"` as a Worker
var.

## Using it

Tap **🧠 Deep analysis with Manus** in `/menu`. The Worker sends the current
window's signals to Manus, replies with the agent's task URL, and does nothing
else. Open the URL to watch the run; the answer appears there.

Profiles:

| Profile | What it means |
|---|---|
| `lite` | Fastest, fewest credits. A quick second opinion |
| `standard` | The default. Right for a daily read |
| `max` | Deepest reasoning, longest runs, most credits |

## What is sent

One bounded prompt, built by `worker/src/manusbrief.ts`:

- a fixed instruction (the Khmer24 analyst brief, under 400 words, fixed structure)
- up to 45 signals from your current window, grouped by report section and tagged with category
- the exchange rates the brief already fetched

The prompt forbids inventing facts and forbids browsing for extra news — the
signals are the input. Titles are truncated and the signal count is capped, so a
busy day cannot produce an unbounded (or unbilled) prompt.

Nothing else leaves the Worker: no API key, no chat ids, no database.

## API notes

Verified against <https://open.manus.ai/docs/v2>.

- Base URL `https://api.manus.ai`
- Auth header `x-manus-api-key`. Do **not** also send `Authorization` — the API
  rejects both together.
- `POST /v2/task.create` → `{ ok, task_id, task_url, task_title }`
- `GET /v2/task.detail?task_id=` → `{ ok, task: { status } }`
- `GET /v2/task.listMessages?task_id=&order=asc` → `{ ok, messages: [...] }`
- Tasks are created with `interactive_mode: false` — an agent that stops to ask a
  question cannot be answered, because nothing is watching the chat.

The result reader prefers the message marked `delivery_kind: "result"` over the
last assistant message, because the log is full of progress notes like *"opening
the browser"*.

## Testing

```powershell
cd worker
npm run test:manus
```

93 checks with `fetch` stubbed out — no network, no credits. They assert the exact
request shape (header, method, path, body), the handling of each documented
response, error reporting, the bounded wait, the prompt cap, the Telegram
truncation, and that toggling the setting actually persists.

## Deliberate limits

- **Not in the daily brief.** It cannot delay or break the 07:30 send.
- **No automatic fallback.** If Manus is down, the button says so.
- **No retry on webhook.** Telegram retries a webhook it thinks failed; a retry
  would start a second task and spend credits twice. Waiting is only available on
  the admin route.
- **No key in the browser.** `/manus` reports `configured: true/false`, never the
  value.

See `worker/DEPLOY.md` → *Manus (optional deep analysis)* for the operational view.
