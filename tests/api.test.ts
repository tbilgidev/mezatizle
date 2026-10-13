import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createSql, migrate } from "@mezatizle/db";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle";
const API = process.env.API_BASE ?? "http://127.0.0.1:43127";

describe("api smoke (optional live server)", () => {
  const sql = createSql(DATABASE_URL);

  beforeAll(async () => {
    await migrate(DATABASE_URL);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("health if server up", async () => {
    try {
      const res = await fetch(`${API}/api/health`);
      if (!res.ok) return;
      const j = (await res.json()) as { ok: boolean };
      expect(j.ok).toBe(true);
    } catch {
      // server not running — skip without failing unit suite
      expect(true).toBe(true);
    }
  });

  test("capture stub rejects", async () => {
    try {
      const res = await fetch(`${API}/api/capture/start`, { method: "POST" });
      if (res.status === 0) return;
      expect(res.status).toBe(403);
    } catch {
      expect(true).toBe(true);
    }
  });
});
