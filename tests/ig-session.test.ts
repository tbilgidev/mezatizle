import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearIgSession,
  getIgSessionStatus,
  saveIgCookiesText,
  saveIgCredentials,
  ytDlpAuthArgs,
} from "../apps/api/src/modules/ig_session.ts";
import type { AppEnv } from "../apps/api/src/lib/env.ts";

function fakeEnv(storageRoot: string): AppEnv {
  return {
    host: "127.0.0.1",
    port: 43127,
    databaseUrl: "postgres://x",
    storageRoot,
    maxUploadBytes: 1_000_000,
    corsOrigin: "*",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    frameIntervalSeconds: 5,
    profile: {
      profile: "LOCAL",
      asrBackend: "mock",
      ocrBackend: "mock",
      llmBackend: "local-rules",
      allowPaidApis: false,
      hardSpendLimitUsd: 0,
    },
    hardSpendLimitUsd: 0,
  };
}

describe("ig session secrets", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("stores cookies and never exposes content in status", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-ig-"));
    dirs.push(root);
    const env = fakeEnv(root);
    const netscape = `# Netscape HTTP Cookie File
.instagram.com	TRUE	/	TRUE	0	sessionid	testvalue123
`;
    const st = await saveIgCookiesText(env, netscape);
    expect(st.status).toBe("yuklu");
    expect(st.hasCookies).toBe(true);
    expect(JSON.stringify(st)).not.toContain("testvalue123");
    const args = await ytDlpAuthArgs(env);
    expect(args[0]).toBe("--cookies");
    expect(args[1]).toContain("ig-cookies.txt");
  });

  test("masks credentials after save", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-ig-"));
    dirs.push(root);
    const env = fakeEnv(root);
    const st = await saveIgCredentials(env, "backup_user", "secret-pass");
    expect(st.hasCredentials).toBe(true);
    expect(st.usernameMasked).toContain("••");
    expect(JSON.stringify(st)).not.toContain("secret-pass");
    const cleared = await clearIgSession(env);
    expect(cleared.status).toBe("yok");
    expect((await getIgSessionStatus(env)).hasCredentials).toBe(false);
  });

  test("rejects garbage cookies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-ig-"));
    dirs.push(root);
    const env = fakeEnv(root);
    await expect(saveIgCookiesText(env, "not-cookies")).rejects.toThrow();
  });
});
