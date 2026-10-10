# What Kizami Edge processes

For a privacy policy. Adapt to your site; not legal advice. German text: [DATENSCHUTZ.md](DATENSCHUTZ.md).

| Stored | Not stored |
|---|---|
| day (UTC) and hour | IP address |
| event name (`seite` for a page view), optional short detail (a path) | user agent |
| referrer **host** | referrer URL, query strings, search terms |
| country code from Cloudflare | anything on the visitor's device (no cookies, no storage) |
| one 16-character hash per visitor and day | anything that links one day to the next |

- The hash is SHA-256 of `salt | day | IP | user agent`, truncated. The salt is random and exists
  for one day: the first request of the next day deletes it, and a daily schedule does so on days
  without any request. From then on the hash can't be traced back to an IP address, and two days
  of the same visitor can't be linked.
- `DNT: 1` and `Sec-GPC: 1`: nothing is recorded.
- Rows older than 400 days are deleted on every count.
- Legal basis under the GDPR is typically Art. 6(1)(f), legitimate interest in knowing whether the
  site is used.
- Nothing is stored on or read from the visitor's device, which is what § 25 TDDDG and
  Art. 5(3) ePrivacy are about. Whether a site needs consent depends on everything it does, not
  only on this counter; check that for your own site.
