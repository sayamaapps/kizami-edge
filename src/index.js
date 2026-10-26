/**
 * Kizami Edge -- cookieless visitor counting for Cloudflare Pages Functions.
 *
 * Two entry points share one core:
 *   middleware()  counts page views while the page is being served
 *                 (functions/_middleware.js). Nothing runs in the browser.
 *   beacon()      counts events the page reports itself via POST
 *                 (functions/api/hit.js), e.g. clicks on a map marker.
 *
 * Privacy, enforced here rather than promised elsewhere:
 *   - No cookies, no browser storage, no third parties.
 *   - The IP address is never stored. It goes into a SHA-256 hash together
 *     with the user agent, the day and a random salt that exists for that
 *     day only. Every request deletes all older salts (forgetOldSalts), so
 *     from the first request of a new day on, yesterday's hashes cannot be
 *     reversed or linked -- not even by whoever runs the database. A daily
 *     schedule covers days without any request (README, Set up).
 *   - Of the referrer only the host is kept, never the URL (which can carry
 *     search terms). Time is kept to the hour.
 *   - DNT: 1 and Sec-GPC: 1 are honoured: nothing is recorded.
 *   - Rows older than RETENTION_DAYS are deleted on every count.
 *
 * Storage: one D1 database, binding DB, schema in schema.sql. Table and
 * column names are German because they predate this package and existing
 * reports read them (ereignisse = events, besucher = visitors, salz = salt).
 * Days are UTC days.
 */

export const PAGE_VIEW = "seite";
export const RETENTION_DAYS = 400;

const DAY_MS = 86_400_000;
const BOTS = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|go-http|java\/|headless|lighthouse|pingdom|uptime|scan/i;
const HOST = /^[a-z0-9.-]{1,253}$/;
const PATH = /^\/[a-z0-9\-/]{0,63}$/;

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

export function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

/** Oldest day that may stay in the database. */
export function cutoffDay(now, days = RETENTION_DAYS) {
  return utcDay(new Date(now.getTime() - days * DAY_MS));
}

/** DNT or Global Privacy Control: the visitor asked not to be counted. */
export function optedOut(headers) {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

export function looksLikeBot(userAgent) {
  return !userAgent || BOTS.test(userAgent);
}

/**
 * The request comes from this site: Sec-Fetch-Site says same-origin and
 * Origin, when sent, is this site's origin. Keeps foreign pages from
 * counting here with navigator.sendBeacon. Headers are set by the browser,
 * but curl and other clients can send anything: not a security boundary.
 */
export function sameSite(request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

/**
 * Host of a referrer -- given as URL or bare host name -- or null.
 * The site's own host is not a source.
 */
export function referrerHost(value, ownHost) {
  if (typeof value !== "string" || !value) return null;
  let host = value.toLowerCase();
  try { host = new URL(value).host.toLowerCase(); } catch { /* bare host name */ }
  if (!HOST.test(host) || host === String(ownHost).toLowerCase()) return null;
  return host;
}

/** A path of this site: lowercase, digits, dash, slash, at most 64 characters. */
export function sitePath(value) {
  return typeof value === "string" && PATH.test(value) ? value : null;
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The salt of `day`. Created by the first count of the day; the same
 * statement batch deletes every older salt. INSERT OR IGNORE makes
 * concurrent first counts agree on one value.
 */
export async function daySalt(db, day) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO salz (tag, wert) VALUES (?, ?)").bind(day, randomHex(32)),
    db.prepare("DELETE FROM salz WHERE tag < ?").bind(day),
  ]);
  const row = await db.prepare("SELECT wert FROM salz WHERE tag = ?").bind(day).first();
  if (!row?.wert) throw new Error("no salt for " + day);
  return row.wert;
}

/**
 * Deletes every salt older than today. Runs on EVERY request the site gets
 * (bots, robots.txt, HEAD, pages.dev included), not only on counted ones:
 * otherwise a quiet day would keep yesterday's salt -- and yesterday's
 * hashes reversible -- until the next counted visit. Costs nothing when
 * there is nothing to delete. Sites with very little traffic should also
 * run this on a daily schedule (see README).
 */
export async function forgetOldSalts(db, now = new Date()) {
  try {
    await db.prepare("DELETE FROM salz WHERE tag < ?").bind(utcDay(now)).run();
  } catch (error) {
    console.error("kizami-edge: old salts not deleted:", error);
  }
}

/** SHA-256 of salt, day, IP and user agent; 16 hex characters remain. */
export async function dayHash(salt, day, ip, userAgent) {
  const data = new TextEncoder().encode(`${salt}|${day}|${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stores one event and the day's visitor. Errors are logged and swallowed:
 * counting must never break the site.
 */
export async function record(db, request, { event = PAGE_VIEW, detail = null, source = null, now = new Date() } = {}) {
  try {
    const day = utcDay(now);
    const salt = await daySalt(db, day);
    const visitor = await dayHash(
      salt, day,
      request.headers.get("cf-connecting-ip") || "",
      request.headers.get("user-agent") || "",
    );
    const cutoff = cutoffDay(now);
    await db.batch([
      db.prepare(
        `INSERT INTO ereignisse (tag, stunde, ereignis, detail, quelle, land)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(day, now.getUTCHours(), event, detail, source, request.cf?.country ?? null),
      db.prepare("INSERT OR IGNORE INTO besucher (tag, besucher_hash) VALUES (?, ?)").bind(day, visitor),
      db.prepare("DELETE FROM ereignisse WHERE tag < ?").bind(cutoff),
      db.prepare("DELETE FROM besucher WHERE tag < ?").bind(cutoff),
    ]);
    return true;
  } catch (error) {
    console.error("kizami-edge: not counted:", error);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point 1: count while serving                                  */
/* ------------------------------------------------------------------ */

/**
 * A page view worth counting: a browser navigating to one of `paths`.
 * Sec-Fetch-Dest: document is sent by browsers on navigation and almost
 * never by bots; prefetches and the *.pages.dev address don't count.
 */
export function isPageView(request, status, { paths = ["/"], skipHosts = [/\.pages\.dev$/] } = {}) {
  if (request.method !== "GET") return false;
  if (status !== 200 && status !== 304) return false;
  const url = new URL(request.url);
  if (skipHosts.some((pattern) => pattern.test(url.hostname))) return false;
  const path = url.pathname.endsWith("/index.html") ? url.pathname.slice(0, -10) : url.pathname;
  if (!paths.includes(path)) return false;
  const h = request.headers;
  if (h.get("sec-fetch-dest") !== "document") return false;
  if ((h.get("sec-purpose") || h.get("purpose") || "").includes("prefetch")) return false;
  if (optedOut(h)) return false;
  return !looksLikeBot(h.get("user-agent"));
}

/**
 * Pages Functions middleware:
 *   import { middleware } from "kizami-edge";
 *   export const onRequest = middleware({ paths: ["/"] });
 * The response passes through unchanged.
 */
export function middleware(options = {}) {
  const binding = options.binding || "DB";
  return async function onRequest(context) {
    const response = await context.next();
    try {
      const db = context.env?.[binding];
      if (db) context.waitUntil(forgetOldSalts(db));
      if (db && isPageView(context.request, response.status, options)) {
        const url = new URL(context.request.url);
        const source = referrerHost(context.request.headers.get("referer"), url.host);
        const detail = options.recordPath ? sitePath(url.pathname) : null;
        context.waitUntil(record(db, context.request, { detail, source }));
      }
    } catch (error) {
      console.error("kizami-edge: skipped:", error);
    }
    return response;
  };
}

/* ------------------------------------------------------------------ */
/* Entry point 2: events reported by the page                          */
/* ------------------------------------------------------------------ */

/**
 * Handlers for functions/api/hit.js:
 *   import { beacon } from "kizami-edge";
 *   export const { onRequestPost, onRequestGet } = beacon({
 *     events: ["seite", "messstelle"],
 *     detail: (value) => typeof value === "string" ? value.slice(0, 64) : null,
 *   });
 * Body: { ereignis, detail?, quelle? }. `quelle` lets the page pass
 * document.referrer, because navigator.sendBeacon sends the page itself as
 * Referer. Default detail: a path of this site (sitePath). Requests from
 * other sites get 403 (sameSite).
 */
export function beacon({ events = [PAGE_VIEW], detail = sitePath, binding = "DB" } = {}) {
  const allowed = new Set(events);

  async function onRequestPost({ request, env }) {
    const db = env?.[binding];
    if (db) await forgetOldSalts(db);
    if (!sameSite(request)) return new Response("cross-site request", { status: 403 });
    if (!db || optedOut(request.headers) || looksLikeBot(request.headers.get("user-agent"))) {
      return new Response(null, { status: 204 });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid request", { status: 400 });
    }
    const event = String(payload?.ereignis || PAGE_VIEW);
    if (!allowed.has(event)) {
      return new Response("unknown event", { status: 400 });
    }
    const ownHost = new URL(request.url).host;
    const source = referrerHost(payload.quelle, ownHost)
      ?? referrerHost(request.headers.get("referer"), ownHost);
    await record(db, request, { event, detail: detail(payload.detail) ?? null, source });
    return new Response(null, { status: 204 });
  }

  async function onRequestGet({ env } = {}) {
    const db = env?.[binding];
    if (db) await forgetOldSalts(db);
    return new Response("POST only.", { status: 405 });
  }

  return { onRequestPost, onRequestGet };
}
