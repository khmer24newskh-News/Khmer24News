# Khmer24 Business Intelligence

News is discovered, classified, turned into business opportunities and sales
actions, and sent to Telegram as a daily brief.

```
NEWS -> IMPACT -> CUSTOMER -> OPPORTUNITY -> ACTION -> TELEGRAM
```

**Live now:** <https://khmer24news.khmer24newskh.workers.dev>
Brief: <https://khmer24news.khmer24newskh.workers.dev/intel>
Menu: <https://khmer24news.khmer24newskh.workers.dev/settings>

> **Nothing needs to run on your machine.** The Cloudflare Worker in
> [`worker/`](worker/) does everything: it fetches all 34 sources itself on a
> 10-minute cron, classifies, scores, alerts, sends the 07:30 brief, and serves
> the dashboard and the menu. Both Windows scheduled tasks that used to run here
> are **disabled**.
>
> The Python app in this folder is **optional legacy fallback**. It still works
> and can push into `POST /ingest`, but nothing runs it automatically and the
> Worker does not depend on it. See
> [`worker/DISCOVERY-NOTES.md`](worker/DISCOVERY-NOTES.md) for how the Worker
> became able to fetch its own sources after Google News refused Cloudflare.

> **This repository is public.** `.env` holds a live Telegram bot token and is
> gitignored — keep it that way. Git history is permanent: if a secret is ever
> committed, deleting the file does **not** remove it from earlier commits, so
> rotate the token immediately with @BotFather `/revoke`.

---

## Cloudflare Worker (the real system)

```powershell
cd worker
npm install
npm run verify           # typecheck + secret audit + 439 tests
npx wrangler deploy
```

See [`worker/DEPLOY.md`](worker/DEPLOY.md) for bindings, secrets, the 8-section
report, the alert cards, the menu, Workers AI, and every route.

Four things worth knowing without reading the rest:

- **Google News is not used.** It answers Cloudflare with HTTP 503 under all
  eight strategies that were measured. Bing News RSS works, so the 20
  `site:` queries became 20 topical queries with keyword filters. Query length
  matters: `Cambodia economy` returns 9 articles,
  `Cambodia economic growth statistics inflation` returns 0.
- **Check the sources at any time:** `/diag/sources?key=…` reports per-source
  counts without storing anything. If `working` is not close to `total_sources`,
  the unattended cron is not trustworthy.
- **Run the secret audit before every push:** `npm run audit:secrets`. It
  compares the real values in `.env` and `.dev.vars` against every file git
  would stage, which a regex cannot do.
- **Alert cards are earned, not assumed.** A story becomes a
  BREAKING NEWS card only if it is about Cambodia in a category that moves
  demand, or a shock from a major trading partner in trade, money or tax.
  Measured at 2% of articles; the rest arrive as a short batched list.

---

## Legacy: the Python app

Kept for manual use and as a fallback fetcher. It is not required.

1. Install Python 3.11+ (tick **Add python.exe to PATH**).
2. Put the folder anywhere, e.g. `D:\Software\Khmer24_News`.
3. Double-click **`run.bat`**.
   - It creates `.venv`, installs the packages, and copies `.env.example` to `.env`.
4. Edit **`.env`** — set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (see §2).
5. Run **`telegram_daily.bat`** once, or in the project folder:
   ```
   .venv\Scripts\python.exe send_daily.py --check
   ```
   Both lines must show `[x]`. `--dry-run` prints the report without sending it.
6. Double-click `run.bat` again and open <http://127.0.0.1:5000>.

> `.env` holds your bot token — it is in `.gitignore` and must never be shared.
> `.env.example` is the template; it should only ever contain placeholders.

## 2. Your Telegram bot

Use the bot you already created (`sansavybot` / `@Khmer24NewsBot`).
Create a **new** token with @BotFather rather than reusing one that has ever
been written into a file you shared:

1. @BotFather → `/revoke` → pick the bot → copy the new token.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN=...`
3. Send any message to the bot once (Telegram cannot deliver to a chat that has
   never messaged the bot).
4. Get your numeric id from @userinfobot, or just run
   `send_daily.py --check`, which reports exactly what is wrong.
5. For a **group**, the id looks like `-1001234567890` — keep the minus sign.

`send_daily.py --check` validates both values without sending anything.

## 3. Automatic sending

The **Cloudflare Worker is the delivery layer** and is already deployed at
<https://khmer24news.khmer24newskh.workers.dev>. It classifies, scores, alerts,
sends the 07:30 digest, and serves the public dashboard.

This PC is the **fetcher**, because Google News answers Cloudflare's IPs with
HTTP 503 and will not poll from the cloud — see
[`worker/DISCOVERY-NOTES.md`](worker/DISCOVERY-NOTES.md). One local task remains:

| Task | Frequency | Does |
|---|---|---|
| `Khmer24 Alerts` | every 10 min | fetch locally, push to the Worker; the Worker alerts instantly on arrival |
| `Khmer24 Daily Report` | disabled | superseded by the Worker's own 07:30 digest |

```powershell
# what the local task runs
.venv\Scripts\python.exe send_daily.py --push
```

The Worker sends a Telegram alert the moment a new article arrives, and builds
the 07:30 digest from its own database. The PC does not need to be on for the
dashboard or the digest — only for timely alerts.

To fall back to fully local sending (no Cloudflare), run
`send_daily.py --alerts-only` here and re-enable the daily task:
`worker\disable-local.ps1 -Undo`.

## 4. How the pipeline works

**Discovery.** Google News RSS is used only as a discovery layer. Its `link`
field is an opaque `news.google.com/rss/articles/<id>` redirect and the
publisher appears only in `<source href>`, so filtering on the link rejects every
result. Entries are matched on the publisher host instead, and the id is then
decoded through the same RPC the Google web UI uses to store the real URL. If
that fails the Google redirect is kept — it still opens in a browser.

**Freshness.** Only articles published inside `LOOKBACK_HOURS` are kept. This is
what makes the report daily; without it the report would re-send the same
top-scored items from every year. Statistical landing pages ("Tourist arrivals
2015", "Public debt FY2022") are dropped as stale.

**Classification.** Word-boundary keyword matching, so `ev` cannot fire inside
*r**ev**iew* and `ai` cannot fire inside *tr**ai**ning*. Articles whose headline
matches nothing fall back to the publishing body's own remit (an IMF Article IV
→ Cambodia Economy) and are labelled as such; articles from a general news agency
with no match stay "General Business" and are reported as uncategorised rather
than given a fake playbook.

**Scoring.** 0–100 from four parts: keyword strength (0–45), source authority
(0–20), recency (0–25) and whether a sales playbook exists (0–10). The old score
capped at 100 after six keyword hits, so most articles tied.

**De-duplication.** Exact hash on the normalised title, plus a word-overlap
heuristic against the same source's last 7 days to catch the same story filed
under a slightly different headline.

**Report.** Built as a list of messages each under Telegram's 4096-character
limit, splitting at item boundaries. Nothing is silently truncated.

## 5. Configuration

Everything lives in `.env` (see `.env.example` for the annotated list).

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | – | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | – | Target chat, e.g. `-1001234567890` |
| `HOST` / `PORT` | `127.0.0.1` / `5000` | Where the dashboard listens |
| `API_TOKEN` | – | Required by `/api/articles` when set |
| `SECRET_KEY` | random per start | Set it to keep CSRF tokens across restarts |
| `DB_PATH` | `khmer24_bi.db` | SQLite file |
| `LOOKBACK_HOURS` | `48` | How recent an article must be |
| `MAX_ITEMS_PER_SOURCE` | `15` | Cap per source per run |
| `MAX_RESOLVES_PER_RUN` | `40` | Cap on real-URL lookups (2 requests each) |
| `REQUEST_TIMEOUT` | `20` | HTTP timeout in seconds |
| `POLITE_DELAY` | `1.0` | Pause between sources |
| `CLASSIFY_WITH_SUMMARY` | `0` | Leave off — see below |
| `DUP_OVERLAP` | `0.5` | Near-duplicate sensitivity |

To backfill history once, run with a wide window:
```
.venv\Scripts\python.exe send_daily.py --dry-run --lookback 720
```

`CLASSIFY_WITH_SUMMARY` is off on purpose. Google News' `<summary>` is not
article text — it is either a copy of the headline *including the publisher
name* (so "Asian Development **Bank**" matched the `bank` keyword and filed an
ADB project under Banking) or a list of unrelated related links.

### Editing sources, categories and playbooks

All at the top of `app.py`:

- `SOURCES` — add a body with `name`, `domain`, `home`, `tier` and an optional
  `default_category`. Add its host to `BROAD_DOMAINS` if it publishes outside
  Cambodia.
- `CATEGORIES` — keyword lists per category (ASCII keywords use word
  boundaries; Khmer keywords use substring matching).
- `PLAYBOOK` — the opportunity and action text per category.

Adding a source row is all that is needed; classification, scoring and the
report pick it up automatically.

## 6. Security

- The dashboard binds **`127.0.0.1`** by default. It has no login.
- POST routes require a CSRF token.
- `javascript:` / `data:` URLs are stripped before rendering.

**Exposing it on the network.** If you set `HOST=0.0.0.0`, anyone who can reach
the machine can read `/api/articles` and trigger Telegram sends. Set
`API_TOKEN` at the same time; the app prints a warning if you do not. Do not
port-forward it to the internet.

## 7. Troubleshooting

| Symptom | Cause |
|---|---|
| "Telegram is not configured" | `.env` is missing the values, or the app was not restarted after editing it — credentials are read at startup |
| `400 chat not found` | Wrong id, or the bot has never been messaged. Run `--check` |
| "No signals in the last N hours" | Nothing recent matched. Try a wider window, e.g. `?hours=720` |
| Report full of Google links | `MAX_RESOLVES_PER_RUN` reached — raise it and re-run |
| `0.0.0.0` warning at startup | Expected unless `HOST=127.0.0.1` |
| `UnicodeEncodeError` in the console | Should not occur; `send_daily.py` forces UTF-8 output |

Useful URLs: `/health`, `/api/articles`, `/?category=Banking&hours=336`.

## 8. Next upgrade

The keyword layer is deliberately transparent so it can be replaced:

- AI analysis for top 5 opportunities, revenue estimates and Khmer summaries
- Company/customer extraction and CRM lead export
- Semantic duplicate detection (replaces the word-overlap heuristic)
- Per-salesperson assignment and urgent alerts
- Source authority weighting by track record
