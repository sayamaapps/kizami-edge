import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beacon, cutoffDay, dayHash, isPageView, middleware, record, referrerHost, sitePath,
} from "../src/index.js";
import { testDatabase } from "./d1.js";

const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function navigation(url = "https://example.de/", headers = {}, method = "GET") {
  return new Request(url, {
    method,
    headers: { "user-agent": BROWSER, "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7", ...headers },
  });
}

function post(body, headers = {}) {
  return new Request("https://example.de/api/hit", {
    method: "POST",
    headers: { "user-agent": BROWSER, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

async function serve(onRequest, request, env, status = 200) {
  const page = new Response("<!doctype html>page", { status });
  const pending = [];
  const response = await onRequest({ request, env, next: async () => page, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return { response, page };
}

/* --- what counts ------------------------------------------------------- */

test("a browser navigating to a counted path is a page view", () => {
  assert.equal(isPageView(navigation(), 200), true);
  assert.equal(isPageView(navigation("https://example.de/index.html"), 304), true);
  assert.equal(isPageView(navigation("https://example.de/preise/"), 200, { paths: ["/", "/preise/"] }), true);
});

test("bots, prefetches, opt-outs, other paths, pages.dev, HEAD and errors are not", () => {
  const no = (request, status = 200, options) => assert.equal(isPageView(request, status, options), false);
  no(navigation(undefined, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }));
  no(navigation(undefined, { "user-agent": "" }));
  no(navigation(undefined, { "sec-fetch-dest": "" }));
  no(navigation(undefined, { "sec-purpose": "prefetch;prerender" }));
  no(navigation(undefined, { dnt: "1" }));
  no(navigation(undefined, { "sec-gpc": "1" }));
  no(navigation("https://example.de/robots.txt"));
  no(navigation("https://example.pages.dev/"));
  no(navigation(undefined, {}, "HEAD"));
  no(navigation(), 404);
});

test("referrer: host only, own host and junk dropped", () => {
  assert.equal(referrerHost("https://www.google.com/search?q=secret", "example.de"), "www.google.com");
  assert.equal(referrerHost("news.ycombinator.com", "example.de"), "news.ycombinator.com");
  assert.equal(referrerHost("https://example.de/x", "example.de"), null);
  assert.equal(referrerHost("<script>", "example.de"), null);
  assert.equal(referrerHost(undefined, "example.de"), null);
  assert.equal(sitePath("/messstelle/123"), "/messstelle/123");
  assert.equal(sitePath("/x?y=1"), null);
});

/* --- what is stored ---------------------------------------------------- */

test("middleware stores day, hour, referrer host, country and a hash -- never the IP", async () => {
  const db = testDatabase();
  const request = navigation(undefined, { referer: "https://www.google.com/search?q=website+ohne+banner" });
  Object.defineProperty(request, "cf", { value: { country: "DE" } });
  const { response, page } = await serve(middleware(), request, { DB: db });

  assert.equal(response, page, "the response passes through untouched");
  const [event] = db.rows("SELECT tag, stunde, ereignis, detail, quelle, land FROM ereignisse");
  assert.equal(event.ereignis, "seite");
  assert.equal(event.quelle, "www.google.com");
  assert.equal(event.land, "DE");
  assert.equal(event.detail, null);
  const [visitor] = db.rows("SELECT besucher_hash FROM besucher");
  assert.match(visitor.besucher_hash, /^[0-9a-f]{16}$/);
  const everything = JSON.stringify([db.rows("SELECT * FROM ereignisse"), db.rows("SELECT * FROM besucher")]);
  assert.ok(!everything.includes("203.0.113.7"), "IP must not be stored");
  assert.ok(!everything.includes("ohne+banner"), "search terms must not be stored");
});

test("the same visitor counts once per day, a second visitor twice", async () => {
  const db = testDatabase();
  const now = new Date("2026-10-11T08:00:00Z");
  await record(db, navigation(), { now });
  await record(db, navigation(), { now });
  await record(db, navigation(undefined, { "cf-connecting-ip": "198.51.100.9" }), { now });
  assert.equal(db.rows("SELECT COUNT(*) n FROM ereignisse")[0].n, 3);
  assert.equal(db.rows("SELECT COUNT(*) n FROM besucher")[0].n, 2);
});

test("the salt lives for one day: the next day's first count deletes it", async () => {
  const db = testDatabase();
  await record(db, navigation(), { now: new Date("2026-10-11T23:59:00Z") });
  const [yesterday] = db.rows("SELECT tag, wert FROM salz");
  assert.equal(yesterday.tag, "2026-10-11");
  assert.match(yesterday.wert, /^[0-9a-f]{64}$/);

  await record(db, navigation(), { now: new Date("2026-10-12T00:01:00Z") });
  const salts = db.rows("SELECT tag, wert FROM salz");
  assert.deepEqual(salts.map((s) => s.tag), ["2026-10-12"]);
  assert.notEqual(salts[0].wert, yesterday.wert);

  // Same person, two days: two unrelated hashes
  const hashes = db.rows("SELECT besucher_hash FROM besucher ORDER BY tag").map((r) => r.besucher_hash);
  assert.equal(new Set(hashes).size, 2);
});

test("with the salt gone, yesterday's hash can't be recomputed from the IP", async () => {
  const db = testDatabase();
  await record(db, navigation(), { now: new Date("2026-10-11T12:00:00Z") });
  const [{ besucher_hash: stored }] = db.rows("SELECT besucher_hash FROM besucher");
  await record(db, navigation(), { now: new Date("2026-10-12T12:00:00Z") });
  // An attacker knowing IP, user agent and day, but not the deleted salt:
  for (const guess of ["", "salt", (await db.rows("SELECT wert FROM salz"))[0].wert]) {
    assert.notEqual(await dayHash(guess, "2026-10-11", "203.0.113.7", BROWSER), stored);
  }
});

test("rows older than 400 days are deleted on every count", async () => {
  const db = testDatabase();
  db.sqlite.exec(`INSERT INTO ereignisse (tag, stunde, ereignis) VALUES ('2025-09-05', 1, 'seite'), ('2025-09-06', 1, 'seite');
                  INSERT INTO besucher (tag, besucher_hash) VALUES ('2025-09-05', 'a'), ('2025-09-06', 'b');`);
  const now = new Date("2026-10-11T08:00:00Z");
  assert.equal(cutoffDay(now), "2025-09-06");
  await record(db, navigation(), { now });
  assert.deepEqual(db.rows("SELECT tag FROM ereignisse ORDER BY tag").map((r) => r.tag), ["2025-09-06", "2026-10-11"]);
  assert.deepEqual(db.rows("SELECT tag FROM besucher ORDER BY tag").map((r) => r.tag), ["2025-09-06", "2026-10-11"]);
});

test("a failing database never breaks the page", async () => {
  const db = testDatabase();
  db.failNext = true;
  const original = console.error;
  console.error = () => {};
  try {
    const { response, page } = await serve(middleware(), navigation(), { DB: db });
    assert.equal(response, page);
  } finally {
    console.error = original;
  }
});

test("without a DB binding nothing is counted and nothing breaks", async () => {
  const { response, page } = await serve(middleware(), navigation(), {});
  assert.equal(response, page);
});

/* --- beacon ------------------------------------------------------------ */

test("beacon counts allowed events with detail and the referrer from the body", async () => {
  const db = testDatabase();
  const { onRequestPost } = beacon({ events: ["seite", "messstelle"] });
  const response = await onRequestPost({
    request: post({ ereignis: "messstelle", detail: "/messstelle/4711", quelle: "https://duckduckgo.com/?q=x" },
      { referer: "https://example.de/" }),
    env: { DB: db },
  });
  assert.equal(response.status, 204);
  const [event] = db.rows("SELECT ereignis, detail, quelle FROM ereignisse");
  assert.deepEqual({ ...event }, { ereignis: "messstelle", detail: "/messstelle/4711", quelle: "duckduckgo.com" });
});

test("beacon rejects unknown events and junk, honours opt-out and skips bots", async () => {
  const db = testDatabase();
  const { onRequestPost, onRequestGet } = beacon();
  assert.equal((await onRequestPost({ request: post({ ereignis: "kauf" }), env: { DB: db } })).status, 400);
  const broken = new Request("https://example.de/api/hit", { method: "POST", headers: { "user-agent": BROWSER }, body: "{" });
  assert.equal((await onRequestPost({ request: broken, env: { DB: db } })).status, 400);
  assert.equal((await onRequestPost({ request: post({}, { "sec-gpc": "1" }), env: { DB: db } })).status, 204);
  assert.equal((await onRequestPost({ request: post({}, { "user-agent": "curl/8.0" }), env: { DB: db } })).status, 204);
  assert.equal((await onRequestGet()).status, 405);
  assert.equal(db.rows("SELECT COUNT(*) n FROM ereignisse")[0].n, 0);
});

test("schema runs twice without error (existing databases can be upgraded)", async () => {
  const db = testDatabase();
  const { readFileSync } = await import("node:fs");
  db.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
});

/* --- the salt must not outlive its day, even without counted visits --- */

test("any request deletes yesterday's salt, also one that isn't counted", async () => {
  for (const request of [
    navigation(undefined, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }),
    navigation("https://example.de/robots.txt"),
    navigation(undefined, {}, "HEAD"),
    navigation(undefined, { "sec-gpc": "1" }),
  ]) {
    const db = testDatabase();
    db.sqlite.exec("INSERT INTO salz (tag, wert) VALUES ('2000-01-01', 'old')");
    await serve(middleware(), request, { DB: db });
    assert.deepEqual(db.rows("SELECT tag FROM salz"), [], `left a salt after ${request.method} ${request.url}`);
    assert.equal(db.rows("SELECT COUNT(*) n FROM ereignisse")[0].n, 0, "nothing counted");
  }
});

test("a beacon request deletes yesterday's salt, even from a bot", async () => {
  const db = testDatabase();
  db.sqlite.exec("INSERT INTO salz (tag, wert) VALUES ('2000-01-01', 'old')");
  const { onRequestPost } = beacon();
  await onRequestPost({ request: post({}, { "user-agent": "curl/8.0" }), env: { DB: db } });
  assert.deepEqual(db.rows("SELECT tag FROM salz"), []);
});

test("today's salt survives the cleanup", async () => {
  const db = testDatabase();
  await record(db, navigation());
  await serve(middleware(), navigation("https://example.de/robots.txt"), { DB: db });
  assert.equal(db.rows("SELECT COUNT(*) n FROM salz")[0].n, 1);
});

test("beacon counts only requests from its own site", async () => {
  const db = testDatabase();
  const { onRequestPost } = beacon({ events: ["seite"] });
  const send = (headers) => onRequestPost({ request: post({}, headers), env: { DB: db } });
  assert.equal((await send({ origin: "https://other.example.org", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send({ origin: "https://other.example.org" })).status, 403);
  assert.equal((await send({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(db.rows("SELECT COUNT(*) n FROM ereignisse")[0].n, 0, "foreign requests are not counted");
  assert.equal((await send({ origin: "https://example.de", "sec-fetch-site": "same-origin" })).status, 204);
  assert.equal(db.rows("SELECT COUNT(*) n FROM ereignisse")[0].n, 1, "the site's own beacon is counted");
});

test("a GET to the beacon deletes yesterday's salt too", async () => {
  const db = testDatabase();
  db.sqlite.exec("INSERT INTO salz (tag, wert) VALUES ('2000-01-01', 'old')");
  const { onRequestGet } = beacon();
  const response = await onRequestGet({ request: new Request("https://example.de/api/hit"), env: { DB: db } });
  assert.equal(response.status, 405);
  assert.deepEqual(db.rows("SELECT tag FROM salz"), []);
});
