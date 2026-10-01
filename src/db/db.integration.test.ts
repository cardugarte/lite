import { expect } from "jsr:@std/expect";
import postgres from "npm:postgres@3.4.5";

const databaseUrl = Deno.env.get("LITE_TEST_DATABASE_URL")?.trim() || "";

if (!databaseUrl) {
  console.log(
    "ignore: LITE_TEST_DATABASE_URL is unset; integration tests need a disposable Postgres",
  );
}

Deno.test({
  name: "smoke: local integration database accepts a connection",
  ignore: !databaseUrl,
  async fn() {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
    try {
      const rows = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(Number(rows[0].ok)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
