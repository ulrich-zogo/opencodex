import { describe, expect, test } from "bun:test";

async function loadModule() {
  return import("../src/codex/log-guard/processes").catch(() => null);
}

describe("Codex Log Guard process gate", () => {
  test("matches official Codex writer command lines without broad codex substring matching", async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.isCodexWriterCommandLine("codex")).toBe(true);
    expect(mod.isCodexWriterCommandLine("/usr/local/bin/codex exec --json")).toBe(true);
    expect(mod.isCodexWriterCommandLine("codex --model gpt-5 app-server")).toBe(true);
    expect(mod.isCodexWriterCommandLine("/opt/codex-x86_64-unknown-linux-musl exec")).toBe(true);
    expect(mod.isCodexWriterCommandLine("codex-code-mode-host")).toBe(true);
    expect(mod.isCodexWriterCommandLine("node worker.js codex exec")).toBe(false);
    expect(mod.isCodexWriterCommandLine("bun /repo/opencodex/src/cli/index.ts storage codex-logs protect")).toBe(false);
    expect(mod.isCodexWriterCommandLine("hermes-codex-bridge-mcp")).toBe(false);
  });

  test("fails closed when enumeration throws", async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.listRunningCodexProcesses({
      platform: "linux",
      listSnapshots: () => { throw new Error("procfs unavailable"); },
    })).toEqual({ state: "unknown", reason: "enumeration_failed" });
  });

  test("deduplicates matching current-user writer processes", async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.listRunningCodexProcesses({
      platform: "linux",
      listSnapshots: () => [
        { pid: 10, commandLine: "codex exec" },
        { pid: 10, commandLine: "codex exec" },
        { pid: 11, commandLine: "node worker.js codex exec" },
        { pid: 12, commandLine: "codex app-server" },
      ],
    });
    expect(result).toEqual({
      state: "ok",
      processes: [
        { pid: 10, commandLine: "codex exec" },
        { pid: 12, commandLine: "codex app-server" },
      ],
    });
  });
});
