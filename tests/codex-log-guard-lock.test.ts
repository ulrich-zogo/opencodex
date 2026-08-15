import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard lock", () => {
  test("fails fast on same-database contention without using history H", async () => {
    const mod = await import("../src/codex/log-guard/lock").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-lock-"));
    roots.push(root);
    const lockPath = join(root, "log-guard-lock.sqlite");
    const codexHome = join(root, "codex-home");
    const logsDb = join(root, "logs_2.sqlite");
    const deps = { resolveDatabasePath: () => lockPath };

    const outer = mod.withCodexLogGuardLock(codexHome, logsDb, () => {
      return mod.withCodexLogGuardLock(codexHome, logsDb, () => "inner", deps);
    }, deps);

    expect(outer.kind).toBe("completed");
    if (outer.kind !== "completed") return;
    expect(outer.value).toEqual({ kind: "unavailable", reason: "busy" });
  });
});
