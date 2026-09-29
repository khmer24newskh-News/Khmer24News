# Deploying to Cloudflare

Migrates the Python app to a Cloudflare Worker. Afterwards **the PC can be off**
— a Cron Trigger runs the daily job in the cloud.

The Python version is left in place as a working fallback until you have
confirmed the Worker runs. Do not delete it until then.

---

## What you need

- Node 18+ — you have v24
- A Cloudflare account (free tier is enough)
- A browser, for `wrangler login`

## 1. Authenticate

I cannot do this for you — it needs your Cloudflare account. Run in PowerShell:

```powershell
cd D:\Software\Khmer24_News\worker
npx wrangler login
```

This opens a browser, you click "Allow", and a token is stored on your machine.
No secret is ever typed into a chat.

## 2. Create the D1 database

```powershell
npx wrangler d1 create khmer24news
```

It prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "khmer24news"
database_id = "1a2b3c4d-5e6f-..."
```

Copy the **`database_id`** value and put it into `wrangler.toml`, replacing
`00000000-0000-0000-0000-000000000000`. The current placeholder is a valid UUID
so that `wrangler dev` works locally, but a real deploy needs the real id.

## 3. Set the secrets

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put ADMIN_TOKEN
```

`wrangler secret put` prompts you and encrypts the value in Cloudflare. Nothing
is written to disk or to `wrangler.toml`.

- `TELEGRAM_BOT_TOKEN` — the token from @BotFather (use the one already in
  `D:\Software\Khmer24_News\.env` if you have not revoked it)
- `TELEGRAM_CHAT_ID` — `252519238`
- `ADMIN_TOKEN` — **invent this yourself.** It is the password that protects
  `/collect`, `/send`, `/run`, `/preview` and `/api/articles`. Without it those
  endpoints are closed, so nobody can use your bot to spam a chat. Any random
  string of 20+ characters. Do not reuse your Windows password.

  Generate one:
  ```powershell
  -join ((1..48) | ForEach-Object { '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[(Get-Random -Maximum 62)] })
  ```

## 4. Deploy

```powershell
npx wrangler deploy
```

Output ends with the Worker URL, something like
`https://khmer24news.<your-subdomain>.workers.dev`.

The database tables are created automatically on the first request, so there is
no separate migration step. If you prefer to do it explicitly:

```powershell
npx wrangler d1 execute khmer24news --remote --file=./schema.sql
```

## 5. Verify

```powershell
# are the secrets wired up?
curl https://khmer24news.<subdomain>.workers.dev/check
# -> both lines must show [x]

# is the public dashboard alive?
curl https://khmer24news.<subdomain>.workers.dev/health

# collect + build the report WITHOUT sending it
curl "https://khmer24news.<subdomain>.workers.dev/preview?key=YOUR_ADMIN_TOKEN"

# collect for real
curl "https://khmer24news.<subdomain>.workers.dev/collect?key=YOUR_ADMIN_TOKEN"

# send the real report
curl "https://khmer24news.<subdomain>.workers.dev/run?key=YOUR_ADMIN_TOKEN"
```

Open `/` in a browser. Append `?key=YOUR_ADMIN_TOKEN` to get the Fetch and Send
buttons. Without the key the dashboard is read-only — that is intentional.

## 6. Confirm the schedule

`wrangler.toml` sets:

```toml
[triggers]
crons = ["*/10 * * * *", "30 0 * * *"]
```

Two schedules, because there are two jobs:

| Cron | Job |
|---|---|
| `*/10 * * * *` | Fetch every source, store what is new, stream alerts |
| `30 0 * * *` | Also send the daily brief |

The 10-minute cron is what replaced the local Windows scheduled task. **No
machine needs to be switched on for news to arrive.**

Cloudflare cron is **always UTC**. Cambodia is UTC+7, so `00:30 UTC` is
**07:30 in Phnom Penh**. To change the local time, subtract 7 hours.

| Wanted (ICT) | Cron |
|---|---|
| 06:00 | `"30 23 * * *"` |
| 07:30 | `"30 0 * * *"` |
| 12:00 | `"0 5 * * *"` |

Watch a run happen live:

```powershell
npx wrangler tail
```

---

## Streaming alerts (as each source publishes)

Two schedules run from `wrangler.toml`:

```toml
crons = ["*/10 * * * *", "30 0 * * *"]
```

- **every 10 minutes** — collect, then send anything new since the last tick
- **00:30 UTC (07:30 Cambodia)** — the above *plus* the daily digest

The watermark is the article **id**, not a timestamp, so restarts and clock
changes cannot cause duplicates or gaps. A failed send deliberately leaves the
watermark alone, so the next tick retries the same articles.

| Setting | Default | Purpose |
|---|---|---|
| `STREAM_ALERTS` | `1` | Send new articles as they appear |
| `ALERT_BATCH_SIZE` | `3` | Articles per alert message |
| `ALERT_MAX_PER_TICK` | `20` | Cap per tick; the rest wait for the next tick |
| `DAILY_DIGEST` | `1` | Still send the 07:30 report. `0` = alerts only |

**First run sends nothing on purpose.** It primes the watermark to the current
maximum id, so turning alerts on does not dump the whole `LOOKBACK_HOURS`
backlog at you.

| Route | Auth | Purpose |
|---|---|---|
| `/alerts` | **admin** | Run one alert tick now |
| `/alerts?dry=1&json=1` | **admin** | What would be sent, without sending |
| `/alerts/reset` | **admin** | Mute until the next new article |

`/health` reports `pending_alerts`, so you can see how far behind you are. To
mute without losing anything: `/alerts/reset` here, or
`send_daily.py --reset-alerts` for the Python version.

---

## The menu: choose what you actually want to know

`GET /settings` - pick what reaches your brief. Saved in D1, so it applies to the
07:30 send, to `/intel`, and to any manual send.

| Control | What it does |
|---|---|
| **Sections** (8) | Tick only the sections you care about. Untick one and it is neither rendered nor sent. |
| **Sources** (37) | Per-source switches, grouped, each labelled *fetched by the Worker*, *pushed from your PC* or *no feed yet*. |
| **Categories** (11) | Which classified topics count as opportunities worth acting on. |
| **Window** | How far back signals count, 1-720 hours. |
| **Minimum urgency** | `act today` / `this week` / `watch`. Set `act today` and the brief becomes a short decision list. |
| **Send automatically at 07:30** | Off means nothing is sent unless you ask. |
| **Include the AI analyst** | Off removes the AI block and saves a model call. |

Each section shows how many signals are currently stored, so you can see what
turning something off actually costs.

### Presets worth trying

| Goal | Settings |
|---|---|
| Five-minute read | Money + Opportunities, `act today`, AI off |
| Sales manager | Opportunities + Marketplace + Jobs categories, `this week` |
| Full awareness | Everything, `watch`, AI on (the default) |

Two details that matter:

- **Money and Opportunities are the core.** If you untick everything, those two
  come back automatically rather than sending you an empty brief.
- **If a filter leaves nothing**, the report says so and names the setting to
  relax, instead of rendering a blank section.

Verified across the three presets above: 8 -> 2 -> 1 -> 8 sections and
9 -> 2 -> 6 -> 9 opportunities, with the AI call correctly skipped when off.

Saving requires the admin key (`?key=` or `X-Admin-Token`); the page itself is
read-only without it.

---

## Breaking-news alert cards

A story that clears the severity bar arrives as its own message, one article per
message, with Telegram rendering the link preview:

```
🚨 BREAKING NEWS — HIGH
Category: Cambodia macro data or policy

Cambodia's economic growth projected to slow to 3 pct in 2026: IMF
Source: Phnom Penh Post
PHNOM PENH — Cambodia's economic growth is forecast to slow to 3 percent in
2026 from 5.3 percent in 2025, driven by surging energy costs ...

🇰🇭 Cambodia impact: review pricing, promotions and demand forecasts

Source link: https://www.phnompenhpost.com/business/...
```

Four parts, all derived from the stored article:

| Part | Where it comes from |
|---|---|
| `HIGH` | `severity()` — see below |
| `Category: <origin> <type>` | The country the story is about plus a phrase for its classified category, with "shock" appended when it is one. `IMF forecasts Cambodia's growth` reads as **Cambodia macro data or policy**, not "IMF" |
| `Source:` | The publisher, taken from the URL host, not the registry id. "CIB / CDC" is a topic, not something a reader recognises |
| Summary | The feed description, with a repeated headline or trailing " - Outlet" stripped, truncated at 420 characters |
| `🇰🇭 Cambodia impact:` | One imperative line for the category, chosen by what the reader should actually review. A foreign shock in trade, money or prices gets the transmission-channel wording |

### What counts as HIGH

Two routes, because one is too weak and one is too strict:

1. **About Cambodia** — in a category that can move demand, cost or compliance,
   and either describing a shock or scoring 60+.
2. **A shock from a Tier A economy** (China, US, EU, Japan, South Korea, India,
   Thailand, Vietnam) in a category that transmits into Cambodia: trade, tariffs,
   monetary policy, tax.

Route 2 exists because a China-US tariff deal never says "Cambodia" and is
exactly the news that changes import cost. Route 2 is also restricted to Tier A
on purpose: Indonesian rupiah and Malaysian ringgit stories were interrupting on a
par with a China-US deal, which is not useful. A Tier B story needs to mention
Cambodia to qualify.

Measured on 81 real articles: **2 cards (2%)**. Everything else arrives as the
short batched list.

### Keyword matching, and three bugs it caused

Words are matched on word boundaries with English inflection allowed, because
both extremes are wrong:

| Bug | Cause | Fix |
|---|---|---|
| An Anthropic story labelled "US macro shock" | `"us "` matched inside "Autonom**us**" | Word boundaries |
| A China-US tariff deal stopped being HIGH | `"tariff"` stopped matching "**tariffs**" | Allow inflections on needles of 4+ characters |
| Rupiah news labelled "US macro shock" | `"us"` + inflection `d` matched the **USD** in "USD/IDR" | No inflections below 4 characters |

`"ban"` was dropped from the shock list for the same reason: it matched "bank".

### Choosing the style

`/settings` → **Alert style**:

| Style | Behaviour |
|---|---|
| **Cards for high severity** (default) | A card per HIGH article, short batch for the rest |
| **A card for every story** | Every article gets a card. Readable, but a poll run inserts 15–20 |
| **Short list only** | The previous format, no cards |

Plus **Only send HIGH severity**, which silences the routine items entirely if
alerts still feel noisy. Both apply to the 10-minute cron, `/alerts`,
`/collect-cloud` and `/ingest` alike, because the style is read from preferences
inside the sender rather than at each call site.

An article that matched no category keyword is never given a card. It stays a
headline and a link, with no "Business signal requiring review" and no
instruction to classify it by hand.

---

## Before the first push

```powershell
npm run audit:secrets
```

This compares the **actual** credential values from `.env` and `.dev.vars`
against every file git would stage. Pattern matching cannot do this: a generic
`api_key = ...` regex finds shapes, not secrets, and it missed a real admin
token pasted into a documentation example. It needs no git binary.

It exits non-zero on a hit, so it belongs in CI. Verified to fail when a real
value is planted and to pass when clean.

What must stay out, and why:

| Path | Why |
|---|---|
| `.env` | Live bot token, admin key, chat id, Flask secret |
| `worker/.dev.vars` | Local `ADMIN_TOKEN`, read by `wrangler dev` |
| `worker/.dev.vars.example` | The template to copy - placeholders only |
| `khmer24_bi.db` | The legacy local database |
| `daily.log` | Run history and the worker URL |
| `worker/test/fixtures/` | ~600 KB of scraped feed markup, downloaded by `npm test` |

`.gitignore` covers all of these at both levels. `.env.example` and
`.dev.vars.example` are committed deliberately, with placeholders only - the
audit checks them too, so a real value pasted into either is caught.

Also worth doing once, via the GitHub API or the web UI: add a repository
description and a licence. Neither is set.

---

## The Telegram menu: change your brief from the chat

Type `/menu` to **@Khmer24NewsBot** and an inline keyboard appears:

```
💰 MONEY & MARKETS (always on)
✅ 🇰🇭 CAMBODIA
✅ 🌏 ASEAN
✅ 🌎 GLOBAL
✅ 🤖 AI & TECHNOLOGY
✅ 🏢 COMPETITORS
✅ 👥 CUSTOMER & DEMAND
🚀 BUSINESS OPPORTUNITIES (always on)
Urgency: 👀 watch          |  AI: on
📤 Send my brief now
🌐 Full settings in the dashboard  |  Hide
```

| Tap | Effect |
|---|---|
| A section | Switches it on or off and re-renders the menu in place |
| **Money / Opportunities** | Answers "part of every brief" - they cannot be removed |
| **Urgency** | Cycles `act today` → `this week` → `watch` |
| **AI** | Turns the analyst pass on or off |
| **Send my brief now** | Builds and sends the brief immediately, then confirms the count |
| **Full settings** | Opens `/settings` in the browser |
| **Hide** | Removes the buttons, leaves a "type /menu" note |

Commands: `/menu`, `/start`, `/settings` show the menu. `/brief` or `/send` sends
the brief straight away.

The menu and `/settings` write to the same D1 row, so a tap on your phone is
visible on the dashboard on your laptop, and the 07:30 send follows whatever you
last chose.

### Why the tap is answered before the work happens

Telegram gives a button tap about three seconds before it starts spinning.
Building the brief can take far longer - one Workers AI call plus up to three
Telegram deliveries. So the tap is acknowledged and the message re-rendered with
progress *first*, and the slow work runs after. Without this the button hangs
and the user taps again.

### Security

`POST /telegram/hook` requires `X-Telegram-Bot-Api-Secret-Token` to match
`TELEGRAM_WEBHOOK_SECRET`, compared in constant time. Wrong or missing secret is
`403`; `GET` is `405`. Verified against the live worker.

Note that `getWebhookInfo` never returns the secret, so it cannot be used to
confirm the secret is set - the `403` behaviour is the real check.

Routes: `/telegram/hook` (Telegram only), `/telegram/setwebhook?key=` and
`/telegram/webhook-info?key=` (admin).

---

## Workers AI analyst

The rule engine stays the backbone. Workers AI adds what rules cannot do:
reading across unrelated stories and judging what they mean commercially.

| | |
|---|---|
| Model | `@cf/meta/llama-4-scout-17b-16e-instruct` |
| Binding | `[ai] binding = "AI"` in `wrangler.toml` |
| Cost | one call per daily report; the free tier allows 10,000 neurons/day |
| Verify | `GET /ai-check?key=...&model=@cf/...` |
| Disable | `AI_ANALYSIS = "0"` |
| Switch model | `AI_MODEL` var, or `?model=@cf/...` per request |

`llama-3.1-8b-instruct` was the obvious first choice and is **deprecated since
2026-05-30**. Llama 4 Scout was verified end-to-end on this task. Other options
worth testing on your own data:
`@cf/aisingapore/gemma-sea-lion-v4-27b-it` (instruct-tuned for Southeast Asia)
and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

### What the AI is and is not allowed to do

- **It never blocks.** Any failure - quota, model down, malformed JSON - falls
  back to the rule report, and `used: false` with a `reason` is logged.
- **It cannot overwrite a rule.** AI opportunities are **appended** and labelled
  `(AI)`; the deterministic ones, each traceable to a real article, stay first.
- **Output is validated.** Unknown categories are dropped and invalid urgency
  values coerced; opportunities with no evidence and no action are discarded.
- **Truncation is handled.** Output is routinely cut off by `max_tokens`, so the
  parser balances unclosed containers and salvages what completed.
- **Response shape is normalised.** Models return text as a string, a block
  array, a nested `content` array, or an OpenAI-style envelope. The reader walks
  the object rather than assuming one field.

### Grounding

The model is instructed to cite the supplied signals and forbidden from inventing
numbers, companies or events. In practice it does:

```
[act today] Tourism potential
   grounded in : Cambodia Showcases Tourism Potential at G Adventures GX Summit 2026
   customer   : Tourism businesses and investors
   ACTION      : List tourism-related services and packages on Khmer24
```

---

## The 8-section Business Intelligence report

`GET /intel` renders it; `?json=1` returns it as data; `?telegram=1&key=…` sends
it. The 07:30 cron sends it automatically.

| # | Section | Where it comes from |
|---|---|---|
| 1 | Money & Markets | Live FX from a free keyless provider |
| 2 | Cambodia | 14 Bing News topics + Khmer Daily (direct feed) |
| 3 | ASEAN | asean.org (direct) + 6 country topics via Bing News |
| 4 | Global | US Fed, US Fed monetary, ECB, Bank of Japan (direct) |
| 5 | AI & Technology | TechCrunch, Verge, Ars, MIT TR, Google AI, OpenAI, HuggingFace, VentureBeat |
| 6 | Competitors | Registered, but no feeds exist - reported honestly |
| 7 | Customer & Demand | Derived from trade/jobs/tourism stories |
| 8 | Business Opportunities | The synthesis engine |

Every one of these is fetched by the Worker. Measured: 34 sources, 33 working,
85 articles per run in about 4 seconds. See DISCOVERY-NOTES.md for why Google
News was replaced and how to re-measure it.

### Synthesis: NEWS -> IMPACT -> CUSTOMER -> OPPORTUNITY -> ACTION

`src/intel.ts` turns classified articles into recommendations. It is
deliberately **rule-based and transparent** - every recommendation names the
articles that triggered it, so you can check the reasoning rather than trust it.

Each opportunity carries a headline, its evidence, the affected customer, a
concrete action, the Khmer24 categories it maps to, and an urgency
(`act today` / `this week` / `watch`). A weak or strong KHR adds a
currency-specific recommendation.

### What is not covered, and why

The report states its own gaps in a `Coverage gaps` line rather than quietly
omitting sections:

- **Oil and gold** - every free route either needs an API key (EIA,
  metals-api) or no longer works (Stooq returns 404/HTML, not CSV). Add a key in
  `market.ts` to enable them.
- **Competitors** - CamHR, JobNet, BongThom and Jobs.com.kh publish no RSS.
  Tracking them means scraping their listing pages, which breaks whenever they
  redesign. Not implemented.
- **Google News** - answers Cloudflare with 503 under every strategy tried, so
  it is not used at all. Replaced by Bing News topics plus direct publisher
  feeds. See DISCOVERY-NOTES.md.
- **Phnom Penh Post** - its own feed returns 403 to Cloudflare on every path, so
  it is not a direct source. Its coverage still arrives through the Bing topics.

---

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `/` | public | Dashboard. `?key=` adds the Fetch/Send buttons |
| `/health` | public | Status JSON |
| `/check` | public | Telegram credential check, sends nothing |
| `/settings` | read public, **write admin** | The menu: sections, sources, categories |
| `/intel` | public | The 8-section brief. `?json=1`, `?telegram=1&key=` |
| `/telegram/hook` | shared secret | Telegram webhook for `/menu` |
| `/preview` | **admin** | Builds the report and shows it; sends nothing |
| `/collect-cloud` | **admin** | Run the poll now: fetch, store, alert |
| `/send` | **admin** | Send the report now |
| `/run` | **admin** | Collect then send |
| `/api/articles` | **admin** | JSON |
| `/diag/sources` | **admin** | Dry run of the whole poll, per-source counts |
| `/diag/tune` | **admin** | Measure candidate Bing queries |
| `/diag/feeds` | **admin** | Measure candidate feed URLs |
| `/diag/google` | **admin** | Re-test the Google News strategies |
| `/diag/alt` | **admin** | Re-test alternative search engines |
| `/probe` | **admin** | Fetch any URL from Cloudflare's egress |
| `/ingest` | **admin** | Legacy push endpoint; nothing pushes to it now |

Admin = `?key=ADMIN_TOKEN` or the `X-Admin-Token` header.

The `/diag/*` routes are how the source list was chosen and how it can be
re-checked. `/diag/sources` is the one that matters: if it does not report
`working` close to `total_sources`, the unattended cron is not trustworthy.

## Adding `?json=1` to any admin route returns JSON instead of a redirect —
handy for scripting and for checking the deploy.

---

## What is verified, and what is not

**Verified against the live deployment:**
- typecheck clean; 363 tests pass across 6 suites; Python/TypeScript parity check passes
- `GET /health`, `/check`, `/settings`, `/intel`, `/api/articles`, `/alerts/preview` all 200
- `/collect`, `/send`, `/run`, `/alerts`, `/ingest`, `/telegram/setwebhook` all 401 without a key
- **The Worker fetches everything itself:** `/diag/sources` reports 34 sources, 33 working,
  ~85 articles in ~4s, from Cloudflare's egress
- `/collect-cloud` stored 18 new articles and sent 20 alerts with no local machine involved
- Telegram menu: correct secret 200, wrong secret 403, missing header 403, GET 405;
  section toggles, urgency cycle, AI toggle, Send-now (3 messages, 9 opportunities) and
  Hide all work and persist to the same preferences as `/settings`
- `wrangler deploy` succeeded; D1 remote id and the four secrets are in place

**Not verified:** the daily 07:30 delivery has been driven by hand, not left to run
overnight. The cron is deployed and the code path is the same one `/collect-cloud`
exercises, but a 24-hour unattended soak has not been observed.

## If something goes wrong

```powershell
npx wrangler tail                    # live logs
npx wrangler deployments list        # roll back to a previous version
```

**A source silently returns nothing** — check `/diag/sources`. It lists `empty`
(sources that fetched but whose articles all failed the keyword filter) and
`failed` (sources that errored). Both are also logged by the cron as
`poll empty:` and `poll fail:`. Use `/diag/tune` to find a replacement query.

**No alerts arriving** — confirm the crons are deployed with
`npx wrangler triggers`, and that the 10-minute one is actually firing:
`npx wrangler tail` for 10 minutes should show `cron[*/10 * * * *] poll:`.

**`no such table: articles`** — the D1 id in `wrangler.toml` is still the
placeholder. Fix step 2.

**Cron never runs** — free plans allow a limited number of cron invocations, and
the trigger must be present in the deployed config. Check
`npx wrangler triggers deploy` or just hit `/run?key=...` manually.

**403 from Cloudflare** — a custom domain or WAF rule may be in the way on the
existing `khmer24news` route.

## Rollback

The Worker is independent of the Python app. To go back:
disable the cron, or simply ignore the Worker. The Python setup (Task Scheduler
`Khmer24 Daily Report`, `run.bat`, `.venv`) is untouched and still works.

## Cost note

Fits comfortably in the free tier for ~15 feeds/day. The main cost driver would
be `MAX_RESOLVES` — each resolved URL costs 2 extra requests.

---

## Testing

```powershell
npm run typecheck        # both src and test
npm test                 # 104 assertions, no network needed
npm run test:parity      # Worker config vs the Python app - must not drift
npm run test:telegram    # live Bot API: check + a real test message
npm run test:capture     # re-record the RSS fixtures
```

`test:telegram` and `send:report` read credentials from
`D:\Software\Khmer24_News\.env` **at runtime, into memory only** — nothing is
copied to disk and the token is never printed. They send real messages to your
chat, so expect a couple of test deliveries.

To build a real report and send it without deploying:

```powershell
npm run dev
# in another shell, after a collect. The key is whatever ADMIN_TOKEN is in
# .dev.vars, which is gitignored - copy .dev.vars.example and fill it in.
$env:DEV_ADMIN_TOKEN = "the value you put in .dev.vars"
npm run send:report -- "http://127.0.0.1:8787/preview?json=1&key=$env:DEV_ADMIN_TOKEN"
```

### Already verified against the live Bot API

`@Khmer24NewsBot` / chat `252519238`: token valid, chat reachable, guard clauses
reject empty/placeholder/oversized input before any network call, a bad token
returns `Unauthorized` and a bad chat id returns `chat not found` — both as
clean errors rather than crashes — and a real 2932-char report generated by the
Worker's own code was delivered successfully.
