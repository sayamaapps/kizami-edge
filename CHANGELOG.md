# Changelog

## Unreleased

- `beacon()`: requests from other sites get `403`. Before, a foreign page could count visitors and
  events of the site with `navigator.sendBeacon`. Browser-set headers only: a curl-style client can
  still send anything, so this reduces casual counting and is not a security boundary.
- `beacon()`: a GET also deletes old salts, like every other request. Before, a site that used only
  the GET handler kept yesterday's salt until a POST.
- README: install pin is v1.0.1, the version whose privacy text the README describes. v1.0.0 keeps
  yesterday's salt until the next counted visit.

## 1.0.1 (2026-10-10)

- Old salts are now deleted on every request, not only on counted page views. Before, a day
  without counted visits kept yesterday's salt, and with it yesterday's hashes reversible, until
  the next counted visit.
- README: daily scheduled deletion for sites that can go a day without any request; the lockfile
  guard accepts the `git+ssh` form npm writes.

## 1.0.0 (2026-10-10)

First release.

- `middleware()`: counts page views while serving, no browser script.
- `beacon()`: counts events the page reports (`ereignis`, `detail`, `quelle`), compatible with the old `/api/hit`.
- Salt per day inside D1, older salts deleted on the first count of a new day: past hashes can't be reversed, not even with full access to the database. No secret to configure.
- Honours DNT and Sec-GPC; deletes rows older than 400 days on every count.
