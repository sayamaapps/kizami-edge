# Changelog

## 1.0.0 (2026-10-10)

First release.

- `middleware()`: counts page views while serving, no browser script.
- `beacon()`: counts events the page reports (`ereignis`, `detail`, `quelle`), compatible with the old `/api/hit`.
- Salt per day inside D1, older salts deleted on the first count of a new day: past hashes can't be reversed, not even with full access to the database. No secret to configure.
- Honours DNT and Sec-GPC; deletes rows older than 400 days on every count.
