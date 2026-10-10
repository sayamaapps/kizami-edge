# Kizami Edge

Cookieless visitor counting for [Cloudflare Pages](https://pages.cloudflare.com) Functions and D1.
The sibling of [Kizami](https://github.com/simsimmal/kirby-kizami) for Kirby: same idea, no PHP.

- **No cookies, no browser storage, no third parties.** Nothing is stored on the visitor's device.
- **Can count without any script in the browser.** `middleware()` counts while the page is served,
  so the page loads nothing extra. `beacon()` is there for events the page reports itself.
- **No IP address is stored.** It goes into a hash with the user agent, the day and a salt that
  exists for that day only. The first request of a new day, from anyone or anything, deletes all
  older salts; a daily schedule covers days without any request (see [Set up](#set-up)). From then
  on, yesterday's hashes can't be reversed or linked, not even by whoever runs the database.
- **Honours Do Not Track and Global Privacy Control.** With `DNT: 1` or `Sec-GPC: 1`, nothing is recorded.
- **Bot filtering** by user agent and Fetch Metadata (`Sec-Fetch-Dest: document`); prefetches and
  the `*.pages.dev` address don't count.
- **Referrer host only**, never the URL (which can carry search terms). Time to the hour.
- **Deletes rows older than 400 days** on every count. No cron job to forget.
- **Never breaks the site.** If D1 is missing or failing, the page is served and nothing is counted.

## Install

```sh
npm install git+https://github.com/simsimmal/kizami-edge.git#v1.0.0
```

No npm account or token needed; Pages bundles it from `node_modules` on deploy.

**Install from GitHub, never by name.** `kizami-edge` is not published on the npm registry,
so anyone could register the name there. With a GitHub URL npm never asks the registry, and
`package-lock.json` pins the exact commit; deploy with `npm ci`. npm writes the source as
`git+ssh://git@github.com/…` into the lockfile but fetches it over HTTPS, so CI needs no SSH key.
A guard for CI that fails unless the lockfile pins this repository to a full commit:

```sh
node -e 'const p = require("./package-lock.json").packages["node_modules/kizami-edge"];
if (!/^git\+(ssh:\/\/git@|https:\/\/)github\.com\/simsimmal\/kizami-edge\.git#[0-9a-f]{40}$/.test(p?.resolved || "")) process.exit(1)'
```

## Use

Count page views while serving (`functions/_middleware.js`):

```js
import { middleware } from "kizami-edge";
export const onRequest = middleware({ paths: ["/"] });
```

Options: `paths` (counted paths, default `["/"]`; `/x/index.html` counts as `/x/`), `recordPath`
(store the path as `detail`), `skipHosts` (default `[/\.pages\.dev$/]`), `binding` (default `"DB"`).

Count events the page reports (`functions/api/hit.js`):

```js
import { beacon } from "kizami-edge";
export const { onRequestPost, onRequestGet } = beacon({ events: ["seite", "messstelle"] });
```

```js
// in the page
navigator.sendBeacon("/api/hit", JSON.stringify({
  ereignis: "messstelle", detail: "/messstelle/4711", quelle: document.referrer,
}));
```

`quelle` exists because `sendBeacon` sends the page itself as `Referer`. `detail` defaults to a path
of the site (lowercase, digits, `-`, `/`, at most 64 characters); pass `detail: (value) => …` to
allow something else. Unknown events get `400`.

## Set up

1. Create a D1 database and run `schema.sql` (safe to run again).
2. Bind it to the Pages project as `DB`.

No secret is needed: the salt is created per day inside the database.

3. **Delete old salts on a schedule** if the site can go a day without any request. Every request
   deletes them already; the schedule guarantees it. Once a day, against the D1 API:

   ```sql
   DELETE FROM salz WHERE tag < date('now');
   ```

   For example from GitHub Actions with `curl -X POST …/d1/database/<id>/query -d '{"sql": "…"}'`
   and an API token with D1 · Edit.
Both steps can be scripted against the Cloudflare API (`POST /accounts/{id}/d1/database`,
`PATCH /accounts/{id}/pages/projects/{name}` with `deployment_configs.production.d1_databases`).

## Read

Tables keep their German names because existing reports read them
(`ereignisse` = events, `besucher` = visitors, `salz` = salt; days are UTC):

```sql
SELECT tag,
       SUM(ereignis = 'seite') AS page_views,
       (SELECT COUNT(*) FROM besucher b WHERE b.tag = e.tag) AS visitors
FROM ereignisse e GROUP BY tag ORDER BY tag DESC LIMIT 30;
```

## Privacy text

[PRIVACY.md](PRIVACY.md) (English) and [DATENSCHUTZ.md](DATENSCHUTZ.md) (German) describe what is
processed, ready to adapt for a privacy policy. They are not legal advice.

## Develop

```sh
npm test   # node --test against real SQLite (node:sqlite), Node 22.13+
```

## License

MIT
