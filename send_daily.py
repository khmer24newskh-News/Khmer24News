"""
Daily report entry point - used by Windows Task Scheduler.

    python send_daily.py              fetch + send
    python send_daily.py --dry-run    fetch + print, send nothing
    python send_daily.py --check      validate Telegram credentials (read-only)
    python send_daily.py --no-fetch   send the report without collecting

Exit codes:  0 = success   1 = failure (Task Scheduler shows this as the task result)
"""
import argparse
import sys

# Khmer text in the report would crash on a default Windows console (cp1252).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

from dotenv import load_dotenv

load_dotenv()

import app as bi  # noqa: E402  (must come after load_dotenv)


def main() -> int:
    parser = argparse.ArgumentParser(description="Khmer24 daily business report")
    parser.add_argument("--dry-run", action="store_true", help="print the report instead of sending it")
    parser.add_argument("--check", action="store_true", help="validate Telegram credentials and exit")
    parser.add_argument("--no-fetch", action="store_true", help="skip news collection")
    parser.add_argument("--alerts-only", action="store_true", help="collect and send new-article alerts, no daily report")
    parser.add_argument("--no-digest", action="store_true", help="send alerts but skip the daily report")
    parser.add_argument("--push", action="store_true", help="fetch locally and push articles to the cloud Worker")
    parser.add_argument("--push-only", action="store_true", help="push what is already stored locally, do not fetch")
    parser.add_argument("--reset-alerts", action="store_true", help="mute alerts until the next run, keeping stored articles")
    parser.add_argument("--lookback", type=int, default=None, help="override LOOKBACK_HOURS for this run")
    args = parser.parse_args()

    if args.check:
        print("Telegram configuration check")
        lines = bi.telegram_check()
        for line in lines:
            print(line)
        # Non-zero when a check failed, so this is usable in a script.
        return 1 if any(line.lstrip().startswith("[ ]") for line in lines) else 0

    if args.reset_alerts:
        mark = bi.reset_alert_watermark()
        print(f"Alerts muted until the next new article. watermark set to id {mark}")
        return 0

    lookback = args.lookback or bi.LOOKBACK_HOURS

    # ---- push to the cloud Worker ----
    if args.push or args.push_only:
        if args.push_only:
            result = bi.push_sources_to_cloud(bi.CLOUD_WORKER_URL, bi.API_TOKEN)
            print(f"Sources fetched: {result['sources_fetched']}  with new articles: "
                  f"{result['sources_with_new']}  articles: {result['articles']}  "
                  f"inserted: {result['inserted']}")
            if result["error"]:
                print(f"  note: {result['error']}")
            if not result["articles"] and result["error"]:
                return 1
            print("Delivery is handled by the Worker.")
            return 0
        stats = bi.fetch_news(lookback_hours=lookback)
        print(f"Local fetch: new={stats['new']} duplicate={stats['duplicate']} "
              f"stale={stats['stale']} resolved={stats['resolved']} errors={len(stats['errors'])}")
        result = bi.push_to_cloud(bi.CLOUD_WORKER_URL, bi.API_TOKEN, hours=lookback)
        if result["error"]:
            print(f"Push failed: {result['error']}")
            return 1
        print(f"Pushed to the Worker: {result['pushed']} new, {result['skipped']} already there "
              f"(HTTP {result['status']})")
        # The cloud owns delivery from here, so do NOT also send locally -
        # that would deliver the same report twice.
        print("Delivery is handled by the Worker. Use --alerts-only here only if the "
              "Worker is not deployed.")
        return 0

    alerts_only = args.alerts_only
    # For the frequent alert task, the daily digest is opt-in so it is not sent
    # every 5 minutes.
    send_digest = not (alerts_only or args.no_digest)

    if not args.no_fetch:
        print(f"Fetching official-source news (last {lookback}h)...")
        stats = bi.fetch_news(lookback_hours=lookback)
        print(f"  new={stats['new']}  duplicate={stats['duplicate']}  stale={stats['stale']}  "
              f"junk={stats['junk']}  off-domain={stats['offdomain']}  "
              f"not-Cambodia={stats['off_topic']}  undated={stats['undated']}")
        print(f"  links resolved to publisher: {stats['resolved']}  kept as Google redirect: {stats['unresolved']}")
        for error in stats["errors"]:
            print(f"  ! {error}")
        if stats["new"] == 0 and stats["errors"]:
            print("  All sources failed - this looks like a network problem, not an empty feed.")

    # ---- streaming alerts: whatever is new since the last tick ----
    exit_code = 0
    if bi.STREAM_ALERTS and not args.no_digest or alerts_only:
        if args.dry_run:
            pending = bi.pending_alert_articles()
            if not pending:
                print("Alerts: nothing pending (already caught up).")
            for text in bi.build_alert_messages(pending, bi.ALERT_BATCH_SIZE):
                print(f"\n----- ALERT (dry run, {len(text)} chars) -----")
                print(text)
        else:
            alert = bi.send_new_article_alerts()
            if alert["backfilled"]:
                print(f"Alerts primed at id {alert['watermark']}; nothing sent on the first run.")
            elif alert["sent_articles"]:
                print(f"Alerts: {alert['sent_articles']} article(s) in {alert['sent_messages']} message(s).")
            else:
                # Distinguish "nothing new" from "something is broken" in the log.
                print("Alerts: nothing new this tick (watermark %s)." % bi.get_meta("alert_watermark_id"))
            if alert["error"]:
                print(f"  alert send failed: {alert['error']}")
                exit_code = 1

    if not send_digest:
        return exit_code

    messages = bi.build_daily_report(hours=lookback)
    print(f"Report: {len(messages)} message(s), "
          f"{sum(len(m) for m in messages)} chars total")

    if args.dry_run:
        for index, text in enumerate(messages, 1):
            longest = max((len(line) for line in text.splitlines()), default=0)
            print(f"\n----- message {index}/{len(messages)} ({len(text)} chars) -----")
            print(text)
            if longest > bi.TELEGRAM_MAX_LEN:
                print(f"  !! longest line is {longest} chars")
        return exit_code

    if not messages:
        print("Nothing to send.")
        return exit_code

    session = bi.http_session()
    failures = 0
    for index, text in enumerate(messages, 1):
        ok, detail = bi.telegram_send(text, session=session)
        status = "OK  " if ok else "FAIL"
        print(f"  [{status}] message {index}/{len(messages)}: {detail}")
        if not ok:
            failures += 1
            break  # if credentials are wrong, do not hammer the API

    if failures:
        print("Report was not delivered. Run 'send_daily.py --check' to diagnose.")
        return 1
    print("Done.")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
