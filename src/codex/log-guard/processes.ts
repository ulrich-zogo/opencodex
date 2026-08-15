import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import {
  listWindowsSnapshots,
  tokenizeCommandLine,
  type ProcessSnapshot,
} from "../app-server-processes";

export interface CodexWriterProcess {
  pid: number;
  commandLine: string;
}

export type CodexWriterProcessCheck =
  | { state: "ok"; processes: CodexWriterProcess[] }
  | { state: "unknown"; reason: "enumeration_failed" };

export interface CodexWriterProcessIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  listSnapshots?: () => ProcessSnapshot[];
}

const TARGET_TRIPLE = /^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?$/i;

function basename(token: string): string {
  return token.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isOfficialCodexExecutable(token: string): boolean {
  const base = basename(token);
  if (base === "codex" || base === "codex.exe" || base === "codex.cmd") return true;
  const withoutSuffix = base.replace(/\.(?:exe|cmd)$/i, "");
  if (!withoutSuffix.startsWith("codex-")) return false;
  return TARGET_TRIPLE.test(withoutSuffix.slice("codex-".length));
}

function isCodeModeHostExecutable(token: string): boolean {
  const base = basename(token);
  return base === "codex-code-mode-host" || base === "codex-code-mode-host.exe";
}

/**
 * Match only official Codex writer executables at argv0.
 *
 * Every normal Codex invocation may emit persistent diagnostics, not just
 * app-server, so Protect must gate the whole executable family. Later argv
 * tokens deliberately do not count: `node worker.js codex exec` and paths that
 * merely contain "opencodex" are not Codex processes.
 */
export function isCodexWriterCommandLine(commandLine: string): boolean {
  const tokens = tokenizeCommandLine(commandLine.trim());
  if (tokens.length === 0) return false;
  return isOfficialCodexExecutable(tokens[0]!) || isCodeModeHostExecutable(tokens[0]!);
}

function statusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function listLinuxSnapshots(uid: number | undefined): ProcessSnapshot[] {
  if (!existsSync("/proc")) throw new Error("procfs_unavailable");
  const rows: ProcessSnapshot[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const procUid = statusUid(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (uid !== undefined && procUid !== undefined && procUid !== uid) continue;
      const commandLine = readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .replace(/\0/g, " ")
        .trim();
      if (commandLine) rows.push({ pid, commandLine, uid: procUid });
    } catch {
      // A process disappearing mid-enumeration is normal. A top-level procfs
      // failure is handled before the loop and fails closed.
    }
  }
  return rows;
}

function listDarwinSnapshots(uid: number | undefined): ProcessSnapshot[] {
  const output = uid !== undefined
    ? execFileSync("/bin/ps", ["-u", String(uid), "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
    : execFileSync("/bin/ps", ["-axo", "pid=,uid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  const rows: ProcessSnapshot[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = uid !== undefined
      ? /^(\d+)\s+(.*)$/.exec(line)
      : /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = (uid !== undefined ? match[2] : match[3])?.trim() ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine) continue;
    rows.push({
      pid,
      commandLine,
      uid: uid ?? (Number.isSafeInteger(Number(match[2])) ? Number(match[2]) : undefined),
    });
  }
  return rows;
}

function effectiveUid(getuid?: () => number | undefined): number | undefined {
  try {
    return getuid ? getuid() : process.getuid?.();
  } catch {
    return undefined;
  }
}

function defaultSnapshots(platform: NodeJS.Platform, uid: number | undefined): ProcessSnapshot[] {
  if (platform === "win32") return listWindowsSnapshots();
  if (platform === "darwin") return listDarwinSnapshots(uid);
  if (platform === "linux") return listLinuxSnapshots(uid);
  throw new Error("unsupported_process_enumeration_platform");
}

export function listRunningCodexProcesses(io: CodexWriterProcessIo = {}): CodexWriterProcessCheck {
  const platform = io.platform ?? process.platform;
  let snapshots: ProcessSnapshot[];
  try {
    snapshots = io.listSnapshots?.() ?? defaultSnapshots(platform, effectiveUid(io.getuid));
  } catch {
    return { state: "unknown", reason: "enumeration_failed" };
  }

  const byPid = new Map<number, CodexWriterProcess>();
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 1) continue;
    if (!isCodexWriterCommandLine(snapshot.commandLine)) continue;
    if (!byPid.has(snapshot.pid)) {
      byPid.set(snapshot.pid, { pid: snapshot.pid, commandLine: snapshot.commandLine });
    }
  }
  return {
    state: "ok",
    processes: [...byPid.values()].sort((a, b) => a.pid - b.pid),
  };
}
