// A small stand-in for Cloudflare D1 on top of node:sqlite, so the tests run
// the real schema and the real SQL instead of mocks.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

  function statement(sql, values = []) {
    return {
      sql,
      bind: (...next) => statement(sql, next),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      run: async () => sqlite.prepare(sql).run(...values),
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      _run: () => sqlite.prepare(sql).run(...values),
    };
  }

  return {
    sqlite,
    failNext: false,
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("D1 unavailable");
      }
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) s._run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    rows(sql) {
      return sqlite.prepare(sql).all();
    },
  };
}
