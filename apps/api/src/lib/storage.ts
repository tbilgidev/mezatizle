import { mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { assertSafeRelativePath } from "@mezatizle/shared";

export async function ensureStorageDirs(root: string) {
  for (const sub of ["recordings", "audio", "frames", "products", "secrets"]) {
    const mode = sub === "secrets" ? 0o700 : undefined;
    await mkdir(join(root, sub), { recursive: true, ...(mode ? { mode } : {}) });
  }
}

export function safeJoinStorage(root: string, ...parts: string[]) {
  for (const p of parts) {
    if (p.includes("..") || p.includes("\0") || isAbsolute(p)) {
      throw new Error("Güvensiz dosya yolu reddedildi");
    }
    assertSafeRelativePath(p.replace(/\\/g, "/"));
  }
  const abs = resolve(root, ...parts);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Güvensiz dosya yolu reddedildi");
  }
  return abs;
}

export function toStorageKey(root: string, absPath: string): string {
  const rel = relative(resolve(root), resolve(absPath)).replace(/\\/g, "/");
  return assertSafeRelativePath(rel);
}
