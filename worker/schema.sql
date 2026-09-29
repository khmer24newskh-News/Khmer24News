-- D1 schema. Applied automatically by ensureSchema() on first run, but you can
-- also apply it by hand:
--   npx wrangler d1 execute khmer24news --file=./schema.sql

CREATE TABLE IF NOT EXISTS articles(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  title_hash   TEXT NOT NULL,
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_title_hash ON articles(title_hash);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published DESC);
CREATE INDEX IF NOT EXISTS idx_articles_score ON articles(score DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
