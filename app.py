"""
Khmer24 Business Intelligence
============================

Pipeline:  NEWS -> CATEGORY -> BUSINESS OPPORTUNITY -> SALES ACTION -> TELEGRAM

Design notes
------------
* Google News RSS is a *discovery* layer only. It never returns real article
  URLs - `entry.link` is an opaque `news.google.com/rss/articles/<id>` redirect
  and the publisher only appears in `entry.source.href`. Filtering on
  `entry.link` therefore rejects 100% of results; we filter on the source host
  and then resolve the redirect to the real URL.
* Everything is bounded: HTTP timeouts, a per-run cap on URL resolution, a
  lookback window, and a politeness delay between sources.
* The report is scoped to a lookback window, so "daily" actually means daily.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote, quote_plus, urlparse

import feedparser
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

# load_dotenv() MUST run before any os.getenv() call below, otherwise the
# dashboard starts with empty credentials (send_daily.py happened to work only
# because it loaded .env itself before importing this module).
load_dotenv()


def _int_env(name: str, default: int, minimum: int = 0, maximum: int = 10**9) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
# Relative DB_PATH values resolve against the project folder, not the current
# working directory. Otherwise launching send_daily.py from Task Scheduler (or
# any other folder) silently creates a second, empty database.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_db_raw = (os.getenv("DB_PATH") or "").strip() or "khmer24_bi.db"
DB_PATH = _db_raw if os.path.isabs(_db_raw) else os.path.normpath(os.path.join(BASE_DIR, _db_raw))
TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = raw_chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()


def _is_placeholder(value: str) -> bool:
    """True for an empty or still-unfilled .env value."""
    return not value or value.startswith("PUT_") or "YOUR_" in value


def telegram_is_configured() -> bool:
    return not _is_placeholder(TELEGRAM_TOKEN) and not _is_placeholder(raw_chat_id)

APP_URL = os.getenv("APP_URL", "http://127.0.0.1:5000").rstrip("/")
PORT = int(os.getenv("PORT", "5000") or 5000)
HOST = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
API_TOKEN = os.getenv("API_TOKEN", "").strip()
SECRET_KEY = os.getenv("SECRET_KEY", "").strip() or secrets.token_hex(32)

# Cloud Worker: this machine fetches, the cloud sends. Google News refuses
# Cloudflare's IPs, so discovery cannot move. See worker/DISCOVERY-NOTES.md.
CLOUD_WORKER_URL = os.getenv("CLOUD_WORKER_URL", "").strip()

LOOKBACK_HOURS = _int_env("LOOKBACK_HOURS", 48, minimum=1)
# Streaming alerts: send each article as its source publishes it, rather than
# waiting for the daily digest.
STREAM_ALERTS = str(os.getenv("STREAM_ALERTS", "1")).strip() in ("1", "true", "yes")
ALERT_BATCH_SIZE = _int_env("ALERT_BATCH_SIZE", 3, minimum=1, maximum=20)
# Cap per tick. Anything beyond this waits for the next tick, so a bulk upload
# by one source cannot flood the chat.
ALERT_MAX_PER_TICK = _int_env("ALERT_MAX_PER_TICK", 20, minimum=1, maximum=100)
MAX_ITEMS_PER_SOURCE = _int_env("MAX_ITEMS_PER_SOURCE", 15, minimum=1, maximum=100)
MAX_RESOLVES_PER_RUN = _int_env("MAX_RESOLVES_PER_RUN", 40, minimum=0)
REQUEST_TIMEOUT = _int_env("REQUEST_TIMEOUT", 20, minimum=5, maximum=120)
POLITE_DELAY = float(os.getenv("POLITE_DELAY", "1.0") or 1.0)
# Off by default: see the note in fetch_news(). Google's RSS summary is not
# article text and pollutes classification with the publisher's own name.
CLASSIFY_WITH_SUMMARY = str(os.getenv("CLASSIFY_WITH_SUMMARY", "0")).strip() in ("1", "true", "yes")
TELEGRAM_MAX_LEN = 4096

log = logging.getLogger("khmer24")

# --------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------
# tier 1 = primary source (central bank, ministry, multilateral)
# tier 2 = state news agency / secondary
# default_category = the source's own remit, used when no keyword matches. The
#   domain filter already guarantees the article is on-topic for that body, so
#   falling back to its remit beats labelling an IMF Article IV as "General".
SOURCES = [
    {"name": "AKP", "domain": "akp.gov.kh", "home": "https://akp.gov.kh/", "tier": 2, "default_category": None},
    {"name": "MEF", "domain": "mef.gov.kh", "home": "https://mef.gov.kh/", "tier": 1, "default_category": "Cambodia Economy"},
    {"name": "NBC", "domain": "nbc.gov.kh", "home": "https://www.nbc.gov.kh/", "tier": 1, "default_category": "Banking"},
    {"name": "CIB / CDC", "domain": "cib-cdc.gov.kh", "home": "https://cib-cdc.gov.kh/en", "tier": 1, "default_category": "Investment"},
    {"name": "NIS", "domain": "nis.gov.kh", "home": "https://nis.gov.kh/en/main-page-2/", "tier": 1, "default_category": "Cambodia Economy"},
    {"name": "MLVT", "domain": "mlvt.gov.kh", "home": "https://www.mlvt.gov.kh/", "tier": 1, "default_category": "Jobs & Hiring"},
    {"name": "Ministry of Commerce", "domain": "moc.gov.kh", "home": "https://www.moc.gov.kh/", "tier": 1, "default_category": "Marketplace"},
    {"name": "Ministry of Tourism", "domain": "tourism.gov.kh", "home": "https://www.tourism.gov.kh/", "tier": 1, "default_category": "Tourism"},
    {"name": "Ministry of Land Management", "domain": "mlmupc.gov.kh", "home": "https://mlmupc.gov.kh/", "tier": 1, "default_category": "Property"},
    {"name": "Customs & Excise", "domain": "tax.gov.kh", "home": "https://www.tax.gov.kh/", "tier": 1, "default_category": "Government & Regulation"},
    {"name": "IMF Cambodia", "domain": "imf.org", "home": "https://www.imf.org/en/Countries/KHM", "tier": 1, "default_category": "Cambodia Economy"},
    {"name": "World Bank Cambodia", "domain": "worldbank.org", "home": "https://www.worldbank.org/en/country/cambodia", "tier": 1, "default_category": "Cambodia Economy"},
    {"name": "ADB Cambodia", "domain": "adb.org", "home": "https://www.adb.org/countries/cambodia/main", "tier": 1, "default_category": "Investment"},
    {"name": "ASEAN", "domain": "asean.org", "home": "https://asean.org/", "tier": 1, "default_category": "Cambodia Economy"},
    {"name": "WTO", "domain": "wto.org", "home": "https://www.wto.org/", "tier": 1, "default_category": "Marketplace"},
]
SOURCE_BY_NAME = {s["name"]: s for s in SOURCES}
SOURCE_HOSTS = {s["name"]: s["home"].split("//", 1)[-1].split("/", 1)[0].lower() for s in SOURCES}

# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------
# Keywords are matched with word boundaries so that "ev" cannot fire inside
# "review" and "ai" cannot fire inside "training" / "warning". Non-ASCII
# (Khmer) keywords use plain substring matching because Khmer is not
# space-delimited, so \b is not meaningful there.
CATEGORIES: dict[str, list[str]] = {
    "Cambodia Economy": [
        "economy", "gdp", "inflation", "growth", "fiscal", "budget", "revenue",
        "monetary", "deficit", "tariff", "national account", "balance of payments",
        "gross domestic", "expenditure", "productivity", "សេដ្ឋកិច្ច",
    ],
    "Investment": [
        "investment", "investor", "factory", "project", "capital", "cdc", "fdi",
        "foreign direct", "special economic zone", "concession", "manufacturing",
        "assembly plant", "joint venture", "power plant", "solar plant", "solar farm",
        "wind farm", "hydropower", "renewable energy", "electricity", "utility",
        "វិនិយោគ",
    ],
    "Jobs & Hiring": [
        "job", "jobs", "employment", "hiring", "worker", "workers", "salary",
        "skill", "skills", "labor", "labour", "wage", "wages", "recruitment",
        "unemployment", "vocational", "apprentice", "minimum wage", "human resource",
        "ការងារការងារ",
    ],
    "Property": [
        "property", "real estate", "construction", "condo", "condominium", "land",
        "housing", "apartment", "title deed", "land title",
        "urban development", "tower", "residence", "សំណង់", "ដីសម្គាល់",
    ],
    "Auto": [
        "automotive", "vehicle", "vehicles", "electric vehicle", "ev battery",
        "dealer", "motorcycle", "car import", "vehicle import", "showroom",
        "រថយន្ត",
    ],
    "Marketplace": [
        "consumer", "retail", "e-commerce", "ecommerce", "trade", "export",
        "exportation", "import", "marketplace", "supermarket", "wholesale",
        "distribution", "sme", "នាំចេញ", "នាំចូល",
    ],
    "Banking": [
        "bank", "loan", "credit", "interest rate", "finance", "fintech",
        "microfinance", "deposit", "lending", "digital payment", "payment",
        "mobile money", "liquidity", "ធនាគារ", "បញ្ចូល",
    ],
    "Technology & AI": [
        "technology", "digital", "artificial intelligence", "software",
        "startup", "data center", "telecom", "5g", "mobile network",
        "cybersecurity", "broadband", "fiber", "innovation", "ai", "បច្ចេកវិទ្យា",
    ],
    "Government & Regulation": [
        "law", "regulation", "policy", "tax", "government", "ministry",
        "royal decree", "sub-decree", "legal", "customs", "official gazette",
        "licence", "license", "permit", "state council", "រដ្ឋបាល", "ច្បាប់",
    ],
    "Tourism": [
        "tourism", "tourist", "tourists", "hotel", "travel", "visitor arrivals",
        "hospitality", "flight", "airline", "airport", "resort", "ecotourism",
        "ទេសនា",
    ],
}
GENERAL_CATEGORY = "General Business"

# `site:asean.org Cambodia` also returns pan-regional news ("ASEAN Secretary-General
# meets the Governor of New South Wales"). For the multi-country bodies we
# require the article to actually mention Cambodia.
CAMBODIA_MARKERS = ("cambodia", "cambodian", "phnom penh", "កម្ពុជា", "ភ្នំពេញ")
BROAD_DOMAINS = {"imf.org", "worldbank.org", "adb.org", "asean.org", "wto.org"}

# Sales playbook per category: (opportunity, action)
PLAYBOOK: dict[str, tuple[str, str]] = {
    "Investment": (
        "Potential new B2B leads: investor, factory, supplier or HR teams entering Cambodia.",
        "Create a lead and contact the company within 24 hours.",
    ),
    "Jobs & Hiring": (
        "Potential Job-category demand from employers and recruiters.",
        "Identify hiring companies and pitch Khmer24 Job packages.",
    ),
    "Property": (
        "Potential demand from developers, agents and property sellers.",
        "Target developers/agents with Property advertising packages.",
    ),
    "Auto": (
        "Potential demand from dealers and vehicle sellers.",
        "Identify active dealers and offer Auto advertising/business packages.",
    ),
    "Marketplace": (
        "Potential seller/category demand based on consumer and trade signals.",
        "Identify affected seller categories and launch targeted outreach.",
    ),
    "Banking": (
        "Potential change in purchasing power or financing demand.",
        "Review Auto/Property customer demand and partnership opportunities.",
    ),
    "Technology & AI": (
        "Potential new customer segment, jobs and product opportunities.",
        "Create a target list of companies and relevant Job/Business packages.",
    ),
    "Cambodia Economy": (
        "Macro signal that may affect customer demand and sales conversion.",
        "Review targets, promotions and customer segments.",
    ),
    "Government & Regulation": (
        "Potential market or compliance change.",
        "Identify affected customer groups and prepare a sales/product response.",
    ),
    "Tourism": (
        "Potential impact on hospitality, jobs, retail and local demand.",
        "Target hospitality/tourism employers and businesses.",
    ),
}
GENERAL_PLAYBOOK = (
    "Business signal requiring review.",
    "Assign an owner and investigate the affected customer segment.",
)

# Titles that Google surfaces for navigation/placeholder pages.
JUNK_TITLES = {"untitled", "no title", "home", "index", "news", "n/a", "-"}
# Section/listing pages that look like headlines but describe no event.
JUNK_PHRASES = (
    "news items", "news item", "news update", "news flash", "agrifood news",
    "press release", "archive", "archives", "announcements", "announcement",
    "tenders", "procurement", "notices", "newsletter", "gallery", "events",
    "media centre", "media center", "sitemap", "subscribe", "login",
    # Cambodian government CMS pages habitually title every article
    # "Content Detail" / "Article Detail" instead of using the headline.
    "content detail", "article detail", "news detail", "view detail", "detail",
    "welcome", "home page",
)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"})
    return session


def telegram_send(text: str, session: requests.Session | None = None) -> tuple[bool, str]:
    """Send one message. Returns (ok, human readable detail)."""
    if not telegram_is_configured():
        return False, (
            "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env "
            "(and restart the app), then run:  .venv\\Scripts\\python.exe send_daily.py --check"
        )
    if len(text) > TELEGRAM_MAX_LEN:
        return False, f"Refusing to send: message is {len(text)} chars (Telegram limit {TELEGRAM_MAX_LEN})."

    sess = session or http_session()
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload: dict = {"chat_id": raw_chat_id, "text": text, "disable_web_page_preview": True}
    try:
        resp = sess.post(url, json=payload, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        return False, f"Network error talking to Telegram: {type(exc).__name__}: {exc}"

    if resp.ok:
        try:
            chat = (resp.json().get("result") or {}).get("chat") or {}
            who = chat.get("title") or chat.get("username") or chat.get("first_name") or raw_chat_id
            return True, f"Delivered to {who} ({len(text)} chars)."
        except ValueError:
            return True, f"Delivered ({len(text)} chars)."
    try:
        detail = (resp.json() or {}).get("description", resp.text)
    except ValueError:
        detail = resp.text
    return False, f"Telegram error {resp.status_code}: {str(detail)[:300]}"


def telegram_check() -> list[str]:
    """Read-only diagnostic: is the token valid and the chat reachable?"""
    lines: list[str] = []
    sess = http_session()
    if not telegram_is_configured():
        return [
            "  [ ] TELEGRAM_BOT_TOKEN is missing (or still the placeholder).",
            "  [ ] TELEGRAM_CHAT_ID is missing (or still the placeholder).",
            "  -> Edit .env, then re-run this command.",
        ]
    try:
        me = sess.get(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getMe", timeout=REQUEST_TIMEOUT)
        data = me.json()
        if data.get("ok"):
            lines.append(f"  [x] Token valid. Bot: @{data['result'].get('username')} ({data['result'].get('first_name')})")
        else:
            lines.append(f"  [ ] Token rejected: {data.get('description')}")
    except (requests.RequestException, ValueError) as exc:
        lines.append(f"  [ ] Could not reach Telegram: {type(exc).__name__}: {exc}")
        return lines
    try:
        chat = sess.get(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getChat",
            params={"chat_id": raw_chat_id}, timeout=REQUEST_TIMEOUT,
        ).json()
        if chat.get("ok"):
            r = chat["result"]
            lines.append(f"  [x] Chat reachable: {r.get('title') or r.get('username')} (type {r.get('type')})")
        else:
            lines.append(f"  [ ] Chat not found: {chat.get('description')}")
            lines.append("      -> For a group, the id looks like -1001234567890. Keep the minus sign.")
            lines.append("      -> Message the bot once, then find your id via @userinfobot.")
    except (requests.RequestException, ValueError) as exc:
        lines.append(f"  [ ] Could not check chat: {type(exc).__name__}: {exc}")
    return lines


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
_ARTICLES_DDL = """
CREATE TABLE IF NOT EXISTS articles(
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,
    title_hash   TEXT,
    url          TEXT,
    google_url   TEXT,
    source       TEXT,
    tier         INTEGER DEFAULT 1,
    published    TEXT,
    age_hours    REAL,
    category     TEXT,
    score        INTEGER DEFAULT 0,
    summary      TEXT,
    signals      TEXT,
    opportunity  TEXT,
    action       TEXT,
    created_at   TEXT
)
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    conn = db()
    try:
        conn.execute(_ARTICLES_DDL)
        conn.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(articles)")}
        # Additive migration so an existing khmer24_bi.db keeps working.
        for column, ddl in [
            ("title_hash", "ALTER TABLE articles ADD COLUMN title_hash TEXT"),
            ("google_url", "ALTER TABLE articles ADD COLUMN google_url TEXT"),
            ("tier", "ALTER TABLE articles ADD COLUMN tier INTEGER DEFAULT 1"),
            ("age_hours", "ALTER TABLE articles ADD COLUMN age_hours REAL"),
            ("signals", "ALTER TABLE articles ADD COLUMN signals TEXT"),
        ]:
            if column not in existing:
                try:
                    conn.execute(ddl)
                except sqlite3.OperationalError:
                    pass
        for stmt in [
            "CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published DESC)",
            "CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC)",
            "CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category)",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_title_hash ON articles(title_hash)",
        ]:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # pre-existing duplicates; app-level de-dupe still applies
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------
_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s]+", re.UNICODE)
_ASCII_KW = re.compile(r"^[\x00-\x7F]+$")


def normalize_title(title: str) -> str:
    return _WS.sub(" ", _PUNCT.sub(" ", title.lower())).strip()


def title_hash(title: str) -> str:
    return hashlib.sha1(normalize_title(title).encode("utf-8")).hexdigest()


# Words too common to carry meaning when comparing two headlines.
_STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "into", "over", "will",
    "have", "has", "was", "were", "are", "its", "their", "after", "before", "under",
    "about", "says", "said", "new", "amid", "here",
}
_DUP_OVERLAP = float(os.getenv("DUP_OVERLAP", "0.5") or 0.5)


def _content_tokens(title: str) -> set[str]:
    return {
        token
        for token in normalize_title(title).split()
        if len(token) > 3 and token not in _STOPWORDS and not token.isdigit()
    }


def is_near_duplicate(conn: sqlite3.Connection, source: str, title: str, published: str | None) -> bool:
    """
    Best-effort catch for the same story republished under a slightly different
    headline by the same source. Compares only the last 7 days from that source
    to stay cheap. This is a word-overlap heuristic, not semantic dedup.
    """
    tokens = _content_tokens(title)
    if len(tokens) < 3 or not published:
        return False
    try:
        recent = conn.execute(
            "SELECT title FROM articles WHERE source = ? AND published >= ? ORDER BY id DESC LIMIT 60",
            (source, (datetime.fromisoformat(published) - timedelta(days=7)).isoformat(timespec="seconds")),
        ).fetchall()
    except (sqlite3.Error, ValueError):
        return False
    for row in recent:
        other = _content_tokens(row["title"] or "")
        if not other:
            continue
        shared = len(tokens & other)
        if shared and shared / min(len(tokens), len(other)) >= _DUP_OVERLAP:
            return True
    return False


def strip_source_suffix(title: str, source_name: str, publisher: str = "") -> str:
    """
    Google appends ' - <publisher>' to every title. Remove it.

    `publisher` is entry.source.title, which is the exact string Google used, so
    it is the reliable key; the configured aliases are only a fallback.
    """
    title = _WS.sub(" ", title).strip()
    aliases = [a for a in (publisher, source_name, SOURCE_HOSTS.get(source_name, "")) if a]
    # Longest alias first, so "Cambodian Investment Board (CIB)" wins over "CIB / CDC".
    for alias in sorted(set(aliases), key=len, reverse=True):
        for separator in (" - ", " – ", " | ", " — "):
            if title.endswith(separator + alias):
                return title[: -(len(separator) + len(alias))].strip()
    return title


def is_junk_title(title: str) -> bool:
    """Placeholder and section pages that pollute the dashboard."""
    stripped = title.strip()
    if not stripped or len(stripped) < 8:
        return True
    lowered = stripped.lower()
    if lowered in JUNK_TITLES:
        return True
    if re.fullmatch(r"[*\W_]+", stripped):  # '*****+*****'
        return True
    letters = sum(1 for ch in stripped if ch.isalpha())
    if letters < max(4, len(stripped) // 3):
        return True
    # A headline that is *only* a year plus a listing phrase, e.g. "2026 News items".
    if re.fullmatch(r"[\d\s]*(" + "|".join(re.escape(p) for p in JUNK_PHRASES) + r")", lowered):
        return True
    # Short titles that are entirely generic, e.g. "Agrifood News".
    if len(stripped) <= 40 and any(lowered == p or lowered.startswith(p + " ") for p in JUNK_PHRASES):
        return True
    return False


def _keyword_hit(keyword: str, text: str, padded: str) -> bool:
    if _ASCII_KW.match(keyword):
        # IGNORECASE matters: `text` is lowercased but keywords need not be, and a
        # case-sensitive search would make any mixed-case keyword (e.g. "sME")
        # permanently unmatchable.
        return re.search(rf"\b{re.escape(keyword)}\b", text, re.IGNORECASE) is not None
    return keyword in padded


def classify(title: str, summary: str = "") -> tuple[str, list[str]]:
    """Return (category, matched keywords). Word-boundary aware."""
    text = f" {normalize_title(title)} "
    if summary:
        text += " " + normalize_title(summary) + " "
    padded = f"{title} {summary}".lower()

    best_category, best_hits = GENERAL_CATEGORY, []
    best_score = 0
    for category, keywords in CATEGORIES.items():
        hits = [kw for kw in keywords if _keyword_hit(kw, text, padded)]
        if len(hits) > best_score:
            best_category, best_hits, best_score = category, hits, len(hits)
    return best_category, best_hits


def parse_published(entry) -> tuple[str | None, float | None]:
    """Return (ISO-8601 UTC string, age in hours). None when the feed omits a date."""
    raw = entry.get("published") or entry.get("updated")
    dt: datetime | None = None
    if raw:
        try:
            dt = parsedate_to_datetime(raw)
        except (TypeError, ValueError, IndexError):
            dt = None
    if dt is None:
        struct = entry.get("published_parsed") or entry.get("updated_parsed")
        if struct:
            try:
                dt = datetime(*struct[:6], tzinfo=timezone.utc)
            except (TypeError, ValueError):
                dt = None
    if dt is None:
        return None, None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    age = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
    return dt.isoformat(timespec="seconds"), round(age, 1)


def score_article(category: str, hits: list[str], tier: int, age_hours: float | None) -> int:
    """
    0-100, deliberately non-saturating so the ranking stays meaningful.
      keyword strength  0-45
      source authority  0-20
      recency           0-25
      has a playbook    0-10
    """
    keyword_score = {0: 0, 1: 12, 2: 26, 3: 38}.get(len(hits), 45)
    authority = 20 if tier <= 1 else 14
    if age_hours is None:
        recency = 0
    elif age_hours <= 6:
        recency = 25
    elif age_hours <= 24:
        recency = 20
    elif age_hours <= 48:
        recency = 12
    elif age_hours <= 24 * 7:
        recency = 5
    else:
        recency = 0
    playbook = 10 if category in PLAYBOOK else 0
    return int(min(100, keyword_score + authority + recency + playbook))


def business_action(category: str, signals: list[str]) -> tuple[str, str]:
    if category == GENERAL_CATEGORY:
        # No keyword matched, so there is no playbook to run. Be explicit rather
        # than emitting a generic action that reads like a real recommendation.
        return (
            GENERAL_PLAYBOOK[0],
            "No category keyword matched - open the article and classify it by hand.",
        )
    opportunity, action = PLAYBOOK.get(category, GENERAL_PLAYBOOK)
    if signals:
        action += f" Watch for: {', '.join(signals[:4])}."
    return opportunity, action


def pretty_age(age_hours: float | None) -> str:
    if age_hours is None:
        return "date unknown"
    if age_hours < 1:
        return f"{int(age_hours * 60)} min ago"
    if age_hours < 48:
        return f"{age_hours:.0f} h ago"
    return f"{age_hours / 24:.0f} d ago"


def safe_external_url(url: str | None) -> str:
    """Block javascript:/data: URLs before they reach an href attribute."""
    if not url:
        return "#"
    try:
        scheme = urlparse(url).scheme.lower()
    except ValueError:
        return "#"
    return url if scheme in ("http", "https") else "#"


# --------------------------------------------------------------------------
# Google News: fetch + URL resolution
# --------------------------------------------------------------------------
def _source_host_ok(source_name: str, entry) -> bool:
    """
    The publisher host is only available in entry.source.href, never in link.
    Returns True when the entry really came from the configured domain.
    """
    source = entry.get("source") or {}
    href = (source.get("href") or "").strip()
    expected = SOURCE_HOSTS.get(source_name, "").lower()
    if href:
        host = urlparse(href).netloc.lower().split(":")[0]
        return bool(host) and (
            host == expected
            or host.endswith("." + expected)
            or expected.endswith("." + host)
        )
    # Fallback for feeds that omit <source>: trust the publisher name in the title.
    return source_name.lower() in (entry.get("title") or "").lower()


def decode_google_news_url(link: str, session: requests.Session) -> str:
    """
    Google News serves a JS page, not a 302, so allow_redirects is useless.
    Decode the article id through the same batchexecute RPC the web UI uses.
    Returns '' on any failure so the caller can fall back to the Google link.
    """
    match = re.search(r"/articles/([^?&/]+)", link)
    if not match:
        return ""
    article_id = match.group(1)
    try:
        page = session.get(f"https://news.google.com/rss/articles/{article_id}", timeout=REQUEST_TIMEOUT)
        if not page.ok:
            return ""
        element = BeautifulSoup(page.text, "html.parser").select_one("c-wiz > div")
        if not element:
            return ""
        signature = element.get("data-n-a-sg")
        timestamp = element.get("data-n-a-ts")
        if not signature or not timestamp:
            return ""
        rpc = [
            "Fbv4je",
            '["garturlreq",[["en-US","US",["FINANCE_TOP_INDICES","WEB_TEST_1_0_0"],null,null,'
            f'1,1,"US:en",null,180,null,null,null,null,null,0,1],"en-US","US",1,[2,3,4,8],'
            f'1,0,"655000234",0,0,null,0],"{article_id}",{timestamp},"{signature}"]',
        ]
        body = "f.req=" + quote(json.dumps([[rpc]]))
        response = session.post(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
            data=body,
            timeout=REQUEST_TIMEOUT,
        )
        if not response.ok:
            return ""
        for chunk in response.text.split("\n\n"):
            if "garturlres" not in chunk:
                continue
            payload = json.loads(chunk)
            for row in payload:
                if isinstance(row, list) and len(row) > 2 and row[0] == "wrb.fr":
                    decoded = json.loads(row[2])
                    if isinstance(decoded, list) and len(decoded) > 1 and decoded[1]:
                        return str(decoded[1])
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as exc:
        log.debug("URL resolution failed: %s: %s", type(exc).__name__, exc)
    return ""


def fetch_news(lookback_hours: int = LOOKBACK_HOURS, max_resolve: int | None = None) -> dict:
    """
    Collect recent articles from every configured source.

    lookback_hours : only store articles published within this window.
    max_resolve    : cap on Google-News URL resolutions (0 disables resolution).
    """
    if max_resolve is None:
        max_resolve = MAX_RESOLVES_PER_RUN
    stats = {
        "new": 0, "duplicate": 0, "stale": 0, "junk": 0, "offdomain": 0,
        "off_topic": 0, "undated": 0, "resolved": 0, "unresolved": 0, "errors": [],
    }
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, lookback_hours))
    session = http_session()
    resolve_budget = max(0, max_resolve)
    conn = db()
    try:
        for source in SOURCES:
            query = quote_plus(f"site:{source['domain']} Cambodia")
            feed_url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
            try:
                # Explicit timeout + UA: feedparser.parse(url) has neither.
                response = session.get(feed_url, timeout=REQUEST_TIMEOUT)
                response.raise_for_status()
                feed = feedparser.parse(response.content)
            except requests.RequestException as exc:
                message = f"{source['name']}: {type(exc).__name__}: {exc}"
                log.warning(message)
                stats["errors"].append(message)
                continue
            except Exception as exc:  # feedparser can raise on malformed XML
                message = f"{source['name']}: feed parse failed: {type(exc).__name__}: {exc}"
                log.warning(message)
                stats["errors"].append(message)
                continue

            for entry in feed.entries[:MAX_ITEMS_PER_SOURCE]:
                if not _source_host_ok(source["name"], entry):
                    stats["offdomain"] += 1
                    continue

                published, age_hours = parse_published(entry)
                if published is None:
                    stats["undated"] += 1
                    continue
                if datetime.fromisoformat(published) < cutoff:
                    stats["stale"] += 1
                    continue

                raw_title = _WS.sub(" ", html.unescape(entry.get("title", ""))).strip()
                publisher = ((entry.get("source") or {}).get("title") or "").strip()
                title = strip_source_suffix(raw_title, source["name"], publisher)
                if is_junk_title(title):
                    stats["junk"] += 1
                    continue
                if source["domain"] in BROAD_DOMAINS and not any(
                    marker in f"{title} {raw_title}".lower() for marker in CAMBODIA_MARKERS
                ):
                    stats["off_topic"] += 1
                    continue

                summary = ""
                if entry.get("summary"):
                    # Google News' <summary> is not article text: it is either a
                    # copy of the un-stripped headline (so the publisher name
                    # leaks in - "Asian Development Bank" matched our 'bank'
                    # keyword) or a list of unrelated related links. Either way
                    # it is noise for classification, so it is stored for
                    # reference only and excluded unless asked for.
                    summary = BeautifulSoup(entry["summary"], "html.parser").get_text(" ", strip=True)
                    summary = strip_source_suffix(summary, source["name"], publisher)

                digest = title_hash(title)
                exists = conn.execute(
                    "SELECT 1 FROM articles WHERE title_hash = ? OR google_url = ?",
                    (digest, entry.get("link", "")),
                ).fetchone()
                if exists:
                    stats["duplicate"] += 1
                    continue
                if is_near_duplicate(conn, source["name"], title, published):
                    stats["duplicate"] += 1
                    continue

                google_url = entry.get("link", "")
                article_url = ""
                if resolve_budget > 0:
                    article_url = decode_google_news_url(google_url, session)
                    resolve_budget -= 1
                if article_url:
                    stats["resolved"] += 1
                else:
                    article_url = google_url
                    stats["unresolved"] += 1

                category, signals = classify(title, summary if CLASSIFY_WITH_SUMMARY else "")
                if category == GENERAL_CATEGORY and source.get("default_category"):
                    # On-topic for this body by construction, so use its remit and
                    # say so, rather than pretending no category applies.
                    category = source["default_category"]
                    opportunity, action = business_action(category, signals)
                    action += f" (default category for {source['name']}; no keyword matched)"
                else:
                    opportunity, action = business_action(category, signals)
                score = score_article(category, signals, source["tier"], age_hours)

                try:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO articles
                            (title, title_hash, url, google_url, source, tier, published, age_hours,
                             category, score, summary, signals, opportunity, action, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            title, digest, article_url, google_url, source["name"], source["tier"],
                            published, age_hours, category, score, summary[:1200],
                            ", ".join(signals[:6]), opportunity, action,
                            datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        ),
                    )
                except sqlite3.IntegrityError:
                    stats["duplicate"] += 1
                    continue
                stats["new"] += 1

            time.sleep(POLITE_DELAY)
        conn.commit()
    finally:
        conn.close()
    return stats


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def get_articles(limit: int = 100, hours: int | None = None, category: str | None = None) -> list[sqlite3.Row]:
    clauses, params = [], []
    if hours:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(1, hours))).isoformat(timespec="seconds")
        clauses.append("(published IS NULL OR published >= ?)")
        params.append(cutoff)
    if category and category != "all":
        clauses.append("category = ?")
        params.append(category)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    conn = db()
    try:
        return conn.execute(
            f"SELECT * FROM articles {where} ORDER BY score DESC, published DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Streaming alerts: send each article as its source publishes it
# --------------------------------------------------------------------------
def get_meta(key: str, default: str | None = None) -> str | None:
    conn = db()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_meta(key: str, value: str) -> None:
    conn = db()
    try:
        conn.execute("INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, value))
        conn.commit()
    finally:
        conn.close()


def max_article_id() -> int:
    conn = db()
    try:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM articles").fetchone()
        return int(row["m"] or 0)
    finally:
        conn.close()


def articles_after(after_id: int, limit: int) -> list[sqlite3.Row]:
    """Newest-first is wrong here: alerts must go out in publication order."""
    conn = db()
    try:
        return conn.execute(
            "SELECT * FROM articles WHERE id > ? ORDER BY id ASC LIMIT ?", (after_id, limit)
        ).fetchall()
    finally:
        conn.close()


def pending_alert_articles(limit: int | None = None) -> list[sqlite3.Row]:
    """
    Articles that the next alert tick would send, without changing the
    watermark. Used by --dry-run so the preview reflects reality.
    Pass limit=0 for the whole backlog regardless of the per-tick cap.
    """
    watermark = get_meta("alert_watermark_id")
    if watermark is None:
        return []
    try:
        after = int(watermark)
    except (TypeError, ValueError):
        after = 0
    return articles_after(after, limit if limit else ALERT_MAX_PER_TICK)


def count_pending_alerts() -> int:
    """How many articles are waiting to be alerted, ignoring the per-tick cap."""
    watermark = get_meta("alert_watermark_id")
    if watermark is None:
        return 0
    try:
        after = int(watermark)
    except (TypeError, ValueError):
        after = 0
    conn = db()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM articles WHERE id > ?", (after,)).fetchone()
        return int(row["n"] or 0)
    finally:
        conn.close()


def build_alert_messages(rows: list[sqlite3.Row], per_message: int) -> list[str]:
    """One Telegram message per few articles, grouped by source."""
    if not rows:
        return []
    messages: list[str] = []
    for start in range(0, len(rows), max(1, per_message)):
        chunk = rows[start : start + max(1, per_message)]
        stamp = datetime.now().strftime("%H:%M")
        lines = [f"\U0001F514 KHMER24 UPDATE ({len(rows)} new article(s))", ""]
        for row in chunk:
            lines.append(f"• {row['title']}")
            lines.append(f"   {row['source']} | {pretty_age(row['age_hours'])} | {row['category']} | score {row['score']}")
            lines.append(f"   Opportunity: {row['opportunity']}")
            lines.append(f"   Action: {row['action']}")
            lines.append(f"   {safe_external_url(row['url'])}")
            lines.append("")
        if len(messages) == 0:
            lines.insert(0, f"(as of {stamp})")
        # never exceed the limit; drop the tail rather than send a broken message
        messages.append("\n".join(lines).rstrip()[:TELEGRAM_MAX_LEN])
    return messages


def send_new_article_alerts(per_message: int = ALERT_BATCH_SIZE) -> dict:
    """
    Send every article stored since the last alert tick.

    The watermark is the article id, not a timestamp, so nothing is missed or
    repeated across restarts and clock changes.

    On the very first run the watermark is set to the current maximum id and
    nothing is sent: otherwise enabling alerts would dump the entire
    LOOKBACK_HOURS backlog at once.
    """
    result = {"sent_messages": 0, "sent_articles": 0, "watermark": 0, "backfilled": False, "error": None}
    watermark = get_meta("alert_watermark_id")
    if watermark is None:
        result["backfilled"] = True
        result["watermark"] = max_article_id()
        set_meta("alert_watermark_id", str(result["watermark"]))
        return result

    try:
        after = int(watermark)
    except (TypeError, ValueError):
        after = 0

    rows = articles_after(after, ALERT_MAX_PER_TICK)
    if not rows:
        result["watermark"] = after
        return result

    messages = build_alert_messages(rows, per_message)
    if not messages:
        result["watermark"] = int(rows[-1]["id"])
        set_meta("alert_watermark_id", str(result["watermark"]))
        return result

    session = http_session()
    failures = 0
    for text in messages:
        ok, detail = telegram_send(text, session=session)
        if ok:
            result["sent_messages"] += 1
        else:
            failures += 1
            result["error"] = detail
            break
    if failures:
        # Leave the watermark alone so the next tick retries the same articles.
        result["watermark"] = after
        return result

    result["sent_articles"] = len(rows)
    result["watermark"] = int(rows[-1]["id"])
    set_meta("alert_watermark_id", str(result["watermark"]))
    return result


def reset_alert_watermark() -> int:
    """Stop alerting until the next run, without deleting stored articles."""
    current = max_article_id()
    set_meta("alert_watermark_id", str(current))
    return current


# --------------------------------------------------------------------------
# Push to the cloud Worker
# --------------------------------------------------------------------------
#: Source ids the Worker understands for Google News pushes. Mirrors
#: worker/src/registry.ts PUSH_SOURCES. Keep the two in step - the Worker
#: rejects an unknown source id.
PUSH_SOURCE_IDS = (
    "AKP", "MEF", "NBC", "CIB / CDC", "NIS", "MLVT", "Ministry of Commerce",
    "Ministry of Tourism", "Ministry of Land Management", "Customs & Excise",
    "IMF Cambodia", "World Bank Cambodia", "ADB Cambodia", "WTO Cambodia",
    "ASEAN-TH", "ASEAN-VN", "ASEAN-ID", "ASEAN-MY", "ASEAN-PH", "ASEAN-SG",
)

#: Google News queries this machine runs for sources the cloud cannot reach.
#: key = source id, value = (site: domain, extra query terms)
GOOGLE_QUERIES = {
    "AKP": ("akp.gov.kh", ""),
    "MEF": ("mef.gov.kh", ""),
    "NBC": ("nbc.gov.kh", ""),
    "CIB / CDC": ("cib-cdc.gov.kh", ""),
    "NIS": ("nis.gov.kh", ""),
    "MLVT": ("mlvt.gov.kh", ""),
    "Ministry of Commerce": ("moc.gov.kh", ""),
    "Ministry of Tourism": ("tourism.gov.kh", ""),
    "Ministry of Land Management": ("mlmupc.gov.kh", ""),
    "Customs & Excise": ("tax.gov.kh", ""),
    "IMF Cambodia": ("imf.org", "Cambodia"),
    "World Bank Cambodia": ("worldbank.org", "Cambodia"),
    "ADB Cambodia": ("adb.org", "Cambodia"),
    "WTO Cambodia": ("wto.org", "Cambodia"),
    "ASEAN-TH": ("bot.or.th", "economy OR policy OR interest rate"),
    "ASEAN-VN": ("sbv.gov.vn", "economy OR policy OR interest rate"),
    "ASEAN-ID": ("bi.go.id", "economy OR policy OR interest rate"),
    "ASEAN-MY": ("bnm.gov.my", "economy OR policy OR interest rate"),
    "ASEAN-PH": ("bsp.gov.ph", "economy OR policy OR interest rate"),
    "ASEAN-SG": ("mas.gov.sg", "economy OR policy OR interest rate"),
}

#: Sources that publish across many countries, so a hit is not automatically
#: about Cambodia.
BROAD_PUSH_DOMAINS = {"imf.org", "worldbank.org", "adb.org", "wto.org"}


def fetch_push_sources(max_items: int = 12) -> tuple[list[dict], dict]:
    """
    Collect the Google-News-backed sources that the cloud cannot reach, in a
    shape the Worker's /ingest endpoint accepts.
    """
    stats = {"fetched": 0, "failed": 0, "with_new": 0, "stale": 0, "junk": 0, "off_topic": 0, "errors": []}
    session = http_session()
    out: list[dict] = []

    for source_id, (domain, extra) in GOOGLE_QUERIES.items():
        terms = f"site:{domain} Cambodia"
        if extra:
            terms += f" ({extra})"
        url = (
            "https://news.google.com/rss/search?q="
            + quote_plus(terms)
            + "&hl=en-US&gl=US&ceid=US:en"
        )
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            feed = feedparser.parse(resp.content)
        except Exception as exc:
            stats["failed"] += 1
            stats["errors"].append(f"{source_id}: {type(exc).__name__}")
            continue

        stats["fetched"] += 1
        kept = 0
        for entry in feed.entries[:max_items]:
            href = (entry.get("source") or {}).get("href", "") or ""
            if href and domain not in href:
                continue
            raw_title = _WS.sub(" ", html.unescape(entry.get("title", ""))).strip()
            title = strip_source_suffix(raw_title, source_id, (entry.get("source") or {}).get("title", ""))
            if is_junk_title(title):
                stats["junk"] += 1
                continue
            if domain in BROAD_PUSH_DOMAINS and not any(
                m in f"{title} {raw_title}".lower() for m in CAMBODIA_MARKERS
            ):
                stats["off_topic"] += 1
                continue
            published, age_hours = parse_published(entry)
            if published is None or age_hours is None:
                continue
            if age_hours > LOOKBACK_HOURS:
                stats["stale"] += 1
                continue
            out.append(
                {
                    "source": source_id,
                    "title": title,
                    "link": (entry.get("link") or "").strip(),
                    "published": published,
                    "age_hours": age_hours,
                    "summary": "",
                }
            )
            kept += 1
        if kept:
            stats["with_new"] += 1

    return out, stats


def push_sources_to_cloud(worker_url: str, admin_token: str) -> dict:
    """
    Fetch the Google-backed sources locally and push them to the Worker, which
    then classifies, alerts and sends.
    """
    result = {"sources_fetched": 0, "sources_with_new": 0, "articles": 0, "inserted": 0, "error": None, "status": None}
    if not worker_url or not admin_token:
        result["error"] = "CLOUD_WORKER_URL or API_TOKEN is not configured"
        return result

    articles, stats = fetch_push_sources()
    result["sources_fetched"] = stats["fetched"]
    result["sources_with_new"] = stats["with_new"]
    result["articles"] = len(articles)
    if stats["errors"]:
        result["error"] = f"{len(stats['errors'])} source(s) failed: {', '.join(stats['errors'][:3])}"
    if not articles:
        if result["error"] is None:
            result["error"] = "no articles found locally"
        return result

    try:
        resp = http_session().post(
            worker_url.rstrip("/") + "/ingest?key=" + quote(admin_token, safe=""),
            json={"articles": articles},
            timeout=90,
        )
        result["status"] = resp.status_code
        if not resp.ok:
            result["error"] = f"HTTP {resp.status_code}: {resp.text[:300]}"
            return result
        data = resp.json()
        result["inserted"] = int(data.get("inserted", 0))
        alerts = data.get("alerts") or {}
        if alerts.get("sent"):
            result["articles"] = result["articles"]
            result["inserted"] = result["inserted"]
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def push_to_cloud(worker_url: str, admin_token: str, hours: int | None = None) -> dict:
    """
    Send locally-collected articles to the Worker's /ingest endpoint.

    The Worker cannot poll Google News (it answers Cloudflare IPs with 503), so
    this machine fetches and the cloud does the classifying, alerting and
    sending. See worker/DISCOVERY-NOTES.md.
    """
    out = {"pushed": 0, "skipped": 0, "error": None, "status": None}
    if not worker_url or not admin_token:
        out["error"] = "CLOUD_WORKER_URL or ADMIN_TOKEN is not configured"
        return out

    hours = hours or LOOKBACK_HOURS
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, hours))
    conn = db()
    try:
        rows = conn.execute(
            "SELECT title, url, google_url, source, published, age_hours, summary "
            "FROM articles WHERE published IS NOT NULL AND published >= ? ORDER BY id DESC LIMIT 300",
            (cutoff.isoformat(timespec="seconds"),),
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        out["error"] = "nothing local to push"
        return out

    payload = {
        "articles": [
            {
                "source": r["source"],
                "title": r["title"],
                "link": r["url"] or r["google_url"],
                "published": r["published"],
                "age_hours": r["age_hours"],
                "summary": r["summary"],
            }
            for r in rows
        ]
    }
    try:
        resp = http_session().post(
            worker_url.rstrip("/") + "/ingest?key=" + quote(admin_token, safe=""),
            json=payload,
            timeout=60,
        )
        out["status"] = resp.status_code
        if not resp.ok:
            out["error"] = f"HTTP {resp.status_code}: {resp.text[:300]}"
            return out
        data = resp.json()
        out["pushed"] = int(data.get("inserted", 0))
        out["skipped"] = int(data.get("duplicate", 0))
        return out
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out


def category_counts(hours: int = LOOKBACK_HOURS) -> list[tuple[str, int]]:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(1, hours))).isoformat(timespec="seconds")
    conn = db()
    try:
        rows = conn.execute(
            "SELECT category, COUNT(*) AS n FROM articles WHERE published >= ? "
            "GROUP BY category ORDER BY n DESC, category",
            (cutoff,),
        ).fetchall()
        return [(r["category"], r["n"]) for r in rows]
    finally:
        conn.close()


def build_daily_report(top: int = 8, hours: int = LOOKBACK_HOURS) -> list[str]:
    """
    Returns a list of Telegram-sized messages (each <= 4096 chars).
    No hard truncation: sections are dropped or items trimmed instead.
    """
    rows = get_articles(limit=top, hours=hours)
    stamp = datetime.now().strftime("%d %b %Y")
    header = f"\U0001F1F0\U0001F1ED KHMER24 DAILY BUSINESS INTELLIGENCE\n\U0001F4C5 {stamp} (last {hours}h)"

    if not rows:
        return [f"{header}\n\nNo new signals in the last {hours} hours. Run a fetch with a wider LOOKBACK_HOURS to backfill."]

    messages: list[str] = []
    chunk: list[str] = [header, "", "\U0001F525 TOP BUSINESS OPPORTUNITIES"]

    def flush() -> None:
        if len(chunk) > 1:
            messages.append("\n".join(chunk)[:TELEGRAM_MAX_LEN].rstrip())
        chunk.clear()

    for index, row in enumerate(rows, 1):
        block = [
            "",
            f"{index}. {row['title']}",
            f"   Source: {row['source']} | {pretty_age(row['age_hours'])} | score {row['score']}",
            f"   Category: {row['category']}",
            f"   Opportunity: {row['opportunity']}",
            f"   Action: {row['action']}",
            f"   {safe_external_url(row['url'])}",
        ]
        candidate = "\n".join(chunk + block)
        if len(candidate) > TELEGRAM_MAX_LEN:
            flush()
            chunk.extend(["", f"(continued) {index}. {row['title']}",
                          f"   Source: {row['source']} | {pretty_age(row['age_hours'])} | score {row['score']}",
                          f"   Opportunity: {row['opportunity']}",
                          f"   Action: {row['action']}",
                          f"   {safe_external_url(row['url'])}"])
        else:
            chunk.extend(block)
    flush()

    counts = category_counts(hours=hours)
    # Only categories that actually have a sales playbook. "General Business" has
    # none - counting it here would claim leads that nobody can act on.
    ranked = [(n, c) for n, c in counts if n in PLAYBOOK]
    unclassified = sum(c for n, c in counts if n not in PLAYBOOK)
    if ranked:
        focus = ["\U0001F3AF SALES FOCUS TODAY"]
        for name, count in ranked[:5]:
            focus.append(f"   • {name}: {count} signal(s) - review affected customers and create leads.")
        if unclassified:
            focus.append(f"   (+{unclassified} uncategorised signal(s) - open and classify by hand.)")
        candidate = "\n".join(focus)
        candidate = "\n".join(focus)
        if messages and len(messages[-1] + "\n" + candidate) <= TELEGRAM_MAX_LEN:
            messages[-1] = messages[-1] + "\n" + candidate
        else:
            messages.append("\n".join(focus)[:TELEGRAM_MAX_LEN])
    return [m for m in messages if m.strip()]


# --------------------------------------------------------------------------
# Flask app
# --------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = SECRET_KEY

try:
    init_db()
except sqlite3.Error as exc:  # pragma: no cover - only on a broken filesystem
    log.error("Could not initialise %s: %s", DB_PATH, exc)


@app.template_filter("external")
def _external(url: str | None) -> str:
    return safe_external_url(url)


@app.context_processor
def _inject_globals() -> dict:
    return {
        "csrf_token": csrf_token(),
        "lookback_hours": LOOKBACK_HOURS,
        "db_path": DB_PATH,
        "telegram_ready": telegram_is_configured(),
        "telegram_chat_id": raw_chat_id,
        "stream_alerts": STREAM_ALERTS,
        "alert_watermark": get_meta("alert_watermark_id", "not set"),
        "pending_alerts": count_pending_alerts() if STREAM_ALERTS else 0,
    }


def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


@app.before_request
def _csrf_protect() -> None:
    if request.method != "POST":
        return
    sent = request.form.get("csrf_token", "") or request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf", "")
    if not expected or not sent or not hmac.compare_digest(sent, expected):
        abort(400, description="Invalid or missing CSRF token. Reload the page and try again.")


@app.errorhandler(400)
def _bad_request(error):
    flash(str(getattr(error, "description", error)), "error")
    return redirect(url_for("index"))


@app.errorhandler(500)
def _server_error(error):  # pragma: no cover
    log.exception("Unhandled error")
    return (
        "<h1>500 - server error</h1><p>Check the console window for the traceback.</p>"
        '<p><a href="/">Back to the dashboard</a></p>',
        500,
    )


@app.route("/")
def index():
    hours = request.args.get("hours", type=int) or LOOKBACK_HOURS
    hours = max(1, min(hours, 24 * 30))
    category = request.args.get("category", "all")
    rows = get_articles(limit=100, hours=hours, category=category)
    counts = category_counts(hours=hours)
    totals = dict(counts)
    for name in list(CATEGORIES) + [GENERAL_CATEGORY]:
        totals.setdefault(name, 0)
    return render_template(
        "index.html",
        articles=rows,
        sources=SOURCES,
        totals=totals,
        counts=counts,
        hours=hours,
        category=category,
        pretty_age=pretty_age,
    )


@app.route("/send-alerts", methods=["POST"])
def send_alerts():
    """Run one streaming-alert tick: send whatever is new since the last one."""
    stats = fetch_news()
    result = send_new_article_alerts()
    if result["backfilled"]:
        flash(f"Alerts primed at id {result['watermark']}; nothing sent on the first run.", "info")
    elif result["sent_articles"]:
        flash(f"Alerts: {result['sent_articles']} article(s) in {result['sent_messages']} message(s). "
              f"Collected {stats['new']} new.", "ok")
    else:
        flash(f"Alerts: nothing new (collected {stats['new']}, watermark {result['watermark']}).", "info")
    if result["error"]:
        flash(f"Alert send failed - {result['error']}", "error")
    for error in stats["errors"][:3]:
        flash(error, "error")
    return redirect(url_for("index"))


@app.route("/reset-alerts", methods=["POST"])
def reset_alerts():
    mark = reset_alert_watermark()
    flash(f"Alerts muted until the next new article (watermark = {mark}).", "info")
    return redirect(url_for("index"))


@app.route("/refresh", methods=["POST"])
def refresh():
    try:
        stats = fetch_news()
    except Exception as exc:  # never let a bad feed 500 the dashboard
        log.exception("fetch_news failed")
        flash(f"Fetch failed: {type(exc).__name__}: {exc}", "error")
        return redirect(url_for("index"))

    parts = [f"Added {stats['new']} new signal(s)"]
    if stats["duplicate"]:
        parts.append(f"{stats['duplicate']} already seen")
    if stats["stale"]:
        parts.append(f"{stats['stale']} older than {LOOKBACK_HOURS}h")
    if stats["junk"]:
        parts.append(f"{stats['junk']} placeholder page(s)")
    if stats["offdomain"]:
        parts.append(f"{stats['offdomain']} off-domain")
    if stats["off_topic"]:
        parts.append(f"{stats['off_topic']} not about Cambodia")
    if stats["undated"]:
        parts.append(f"{stats['undated']} without a date")
    flash(" | ".join(parts) + ".", "ok" if stats["new"] else "info")
    if stats["unresolved"]:
        flash(
            f"{stats['unresolved']} link(s) kept as Google redirects (resolution budget "
            f"{MAX_RESOLVES_PER_RUN}/run - raise MAX_RESOLVES_PER_RUN in .env for more).",
            "info",
        )
    for error in stats["errors"][:5]:
        flash(error, "error")
    return redirect(url_for("index"))


@app.route("/send-telegram", methods=["POST"])
def send_telegram():
    messages = build_daily_report()
    session_obj = http_session()
    sent = 0
    for text in messages:
        ok, detail = telegram_send(text, session=session_obj)
        if ok:
            sent += 1
        else:
            flash(f"Message {sent + 1} failed - {detail}", "error")
    if sent:
        flash(f"Sent {sent} Telegram message(s).", "ok")
    return redirect(url_for("index"))


@app.route("/api/articles")
def api_articles():
    if API_TOKEN:
        supplied = request.headers.get("X-API-Token", "") or request.args.get("token", "")
        if not hmac.compare_digest(supplied, API_TOKEN):
            return jsonify({"error": "unauthorised"}), 401
    hours = request.args.get("hours", type=int) or LOOKBACK_HOURS
    return jsonify([dict(row) for row in get_articles(limit=200, hours=max(1, hours))])


@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "db": os.path.exists(DB_PATH),
        "telegram_configured": telegram_is_configured(),
        "lookback_hours": LOOKBACK_HOURS,
        "articles": len(get_articles(limit=10000, hours=24 * 365 * 10)),
    })


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if HOST not in ("127.0.0.1", "localhost") and not API_TOKEN:
        print("=" * 72)
        print(f"WARNING: listening on {HOST} with no API_TOKEN.")
        print("Anyone on this network can read /api/articles and trigger Telegram sends.")
        print("Set API_TOKEN in .env, or set HOST=127.0.0.1.")
        print("=" * 72)
    print(f"Khmer24 Business Intelligence -> {APP_URL}  (db: {DB_PATH}, window: {LOOKBACK_HOURS}h)")
    app.run(host=HOST, port=PORT, debug=False)
