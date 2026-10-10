-- Kizami Edge: schema for Cloudflare D1.
--
-- Safe to run again on an existing database (everything IF NOT EXISTS).
-- Databases created by earlier versions of this schema only gain the
-- table `salz`.
--
-- Table and column names are German because existing reports read them:
-- ereignisse = events, besucher = visitors, salz = salt, tag = day (UTC),
-- stunde = hour, quelle = referrer host, land = country.
--
-- Deliberately narrow: no sessions, no paths across pages, nothing finer
-- than the hour. What isn't stored can't leak.

CREATE TABLE IF NOT EXISTS ereignisse (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tag      TEXT    NOT NULL,          -- YYYY-MM-DD, UTC
  stunde   INTEGER NOT NULL,          -- 0 to 23, deliberately no finer
  ereignis TEXT    NOT NULL,          -- 'seite' = page view, or a site event
  detail   TEXT,                      -- optional, at most 64 characters
  quelle   TEXT,                      -- referrer HOST only, never the URL
  land     TEXT                       -- ISO country code from Cloudflare
);

CREATE INDEX IF NOT EXISTS idx_ereignisse_tag      ON ereignisse (tag);
CREATE INDEX IF NOT EXISTS idx_ereignisse_ereignis ON ereignisse (ereignis, tag);

-- Unique visitors per day. The primary key turns INSERT OR IGNORE into a
-- counter: the same visitor on the same day is stored once.
CREATE TABLE IF NOT EXISTS besucher (
  tag           TEXT NOT NULL,
  besucher_hash TEXT NOT NULL,
  PRIMARY KEY (tag, besucher_hash)
);

-- The salt of the current day. Every request deletes older rows, and a daily
-- schedule covers quiet days, so yesterday's hashes can't be reversed by anyone.
CREATE TABLE IF NOT EXISTS salz (
  tag  TEXT PRIMARY KEY,
  wert TEXT NOT NULL
);

-- Typical questions:
--
--   SELECT tag,
--          SUM(ereignis = 'seite') AS page_views,
--          (SELECT COUNT(*) FROM besucher b WHERE b.tag = e.tag) AS visitors
--   FROM ereignisse e GROUP BY tag ORDER BY tag DESC LIMIT 30;
--
--   SELECT quelle, COUNT(*) n FROM ereignisse
--   WHERE quelle IS NOT NULL GROUP BY quelle ORDER BY n DESC LIMIT 20;
