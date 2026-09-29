# Discovery: the Worker fetches everything itself

## Summary

There is no local-PC component. The Worker fetches every source, on its own
10-minute cron, and nothing needs to be switched on for news to arrive.

This file records how that became true, because the opposite was believed for a
while and the reason it was believed is worth not re-deriving.

## What used to be believed

Google News RSS answers **HTTP 503** to Cloudflare Workers. The same feed
returns 200 from a normal IP. The first conclusion was that the cloud could not
do discovery at all, and a local PC had to fetch and push into `/ingest`.

That conclusion was correct about Google News and wrong about the conclusion.

## The measured matrix

Re-tested from the deployed Worker, not from a laptop. Google News, one feed,
eight strategies:

| Strategy | Result |
|---|---|
| plain fetch | HTTP 503 |
| browser User-Agent + Accept headers | HTTP 503 |
| `news.google.co.th` instead of `.com` | HTTP 503 |
| allorigins relay | HTTP 403 |
| codetabs relay | HTTP 522 |
| jina reader | HTTP 429 |
| thingproxy relay | HTTP 530 |
| whateverorigin relay | HTTP 200, no feed items |

Headers and host make no difference, which is the signature of an IP-reputation
decision rather than a content negotiation problem. **Google News is
unavailable from Cloudflare, full stop.** No amount of retrying will change it.

## What works: Bing News RSS

`https://www.bing.com/news/search?q=<query>&format=RSS` answers the same egress
with valid RSS 2.0 and real articles. Measured on this project:

| Query | Articles |
|---|---|
| `Cambodia economy` | 9 |
| `Cambodia central bank` | 6 |
| `Cambodia commerce` | 11 |
| `Cambodia employment` | 9 |
| `site:nbc.gov.kh` | **0** |

The one trap: **Bing ignores `site:`.** A per-publisher query returns an empty
channel, which looks like a working transport returning nothing. So the 20
`site:` queries were replaced by 20 topical queries, and the publisher filter
that `site:` used to provide is re-applied in code as a `mustMention` keyword
list per source.

Query length matters a lot. `Cambodia economic growth statistics inflation`
returns nothing; `Cambodia economic growth` returns 9. Every query was therefore
measured with `/diag/tune` rather than guessed, and each source carries two
fallback queries that are tried in order, so an index shift degrades one source
instead of silently emptying a section.

## Publisher feeds, re-checked

Direct feeds are still better where they work, so they are still used. Two were
replaced after re-measuring:

| Feed | Result |
|---|---|
| Phnom Penh Post (`/rss`, `/rss/news`, `/feed`) | HTTP 403 on all three |
| Khmer Times `/feed/` | HTTP 404 |
| **Khmer Daily `/feed/`** | HTTP 200, 10 items |

Phnom Penh Post was replaced with Khmer Daily. Phnom Penh Post coverage still
reaches the brief through the Bing topics, because Bing indexes it as a
publisher even when its own feed refuses Cloudflare.

## Current state

```
34 sources | 33 working | 85 articles per run | ~4s
```

The only failure is VentureBeat at HTTP 429. It is one of eight technology
sources, so it costs nothing, and 429 is retried once.

Sources that return zero articles are logged explicitly (`poll empty: ...`),
because a silently empty source is indistinguishable from a dead one.

## The legacy path

`POST /ingest` still works and `/collect` still exists, but `DISCOVERY_MODE` is
`poll` and nothing pushes to `/ingest`. The Python app is optional manual
fallback only. Both Windows scheduled tasks (`Khmer24 Alerts`,
`Khmer24 Daily Report`) are **disabled**.

## Re-checking any of this

```
/diag/google?domain=<domain>     the 8 Google News strategies
/diag/alt?domain=<domain>        alternative search engines
/diag/tune?id=<id>&q=a|b|c       measure candidate Bing queries
/diag/feeds?u=<url>|<url>        measure candidate feed URLs
/diag/sources                    dry run of the whole poll, per-source counts
```

All admin-gated. `/diag/sources` is the one that matters: if it does not report
`working ≈ total`, the cron cannot be trusted unattended.
