import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { Database } from "bun:sqlite";

import {
  CodexUserIdentityRefusal,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
  samePathIdentity,
} from "../user-identity";

export type CodexLogGuardLockOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "unavailable"; reason: "busy" | "database" | "unsafe-path" };

export interface CodexLogGuardLockDeps {
  /** Test seam. Production resolves a dedicated DB in the trusted user runtime root. */
  resolveDatabasePath?: (canonicalCodexHome: string, canonicalLogsDbPath: string) => string;
}

function isBusy(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function resolveLogGuardLockDatabase(
  canonicalCodexHome: string,
  canonicalLogsDbPath: string,
): string {
  if (!isAbsolute(canonicalCodexHome) || !isAbsolute(canonicalLogsDbPath)) {
    throw new CodexUserIdentityRefusal("Codex Log Guard lock keys must be absolute paths.");
  }

  const identity = resolveEffectiveUserIdentity();
  // Use the native-coordinator resolver only to enter the already-audited,
  // environment-independent per-user runtime root. L itself is a different
  // database in a sibling directory and never acquires N or H.
  const coordinatorPath = resolveCodexCoordinatorDatabasePath(identity, canonicalCodexHome);
  const runtimeRoot = dirname(dirname(coordinatorPath));
  const locksDir = join(runtimeRoot, "log-guard-locks");
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(locksDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
    || !samePathIdentity(realpathSync.native(locksDir), locksDir)) {
    throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is unsafe.");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || dirStat.uid !== uid || (dirStat.mode & 0o777) !== 0o700) {
      throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is not private to the effective user.");
    }
  }

  const digest = createHash("sha256")
    .update(`${canonicalCodexHome.length}:${canonicalCodexHome}`)
    .update(`${canonicalLogsDbPath.length}:${canonicalLogsDbPath}`)
    .digest("hex");
  return join(locksDir, `${digest}.sqlite`);
}

export function withCodexLogGuardLock<T>(
  canonicalCodexHome: string,
  canonicalLogsDbPath: string,
  work: () => T,
  deps: CodexLogGuardLockDeps = {},
): CodexLogGuardLockOutcome<T> {
  let databasePath: string;
  try {
    databasePath = deps.resolveDatabasePath?.(canonicalCodexHome, canonicalLogsDbPath)
      ?? resolveLogGuardLockDatabase(canonicalCodexHome, canonicalLogsDbPath);
  } catch (error) {
    if (error instanceof CodexUserIdentityRefusal) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    return { kind: "unavailable", reason: "database" };
  }

  let database: Database | undefined;
  let transactionOpen = false;
  try {
    let absent = false;
    try {
      const before = lstatSync(databasePath);
      if (before.isSymbolicLink() || !before.isFile()) {
        return { kind: "unavailable", reason: "unsafe-path" };
      }
      if (process.platform !== "win32") {
        const uid = process.getuid?.();
        if (uid === undefined || before.uid !== uid || (before.mode & 0o777) !== 0o600) {
          return { kind: "unavailable", reason: "unsafe-path" };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      absent = true;
    }

    database = new Database(databasePath, { create: true });
    if (absent) {
      try { chmodSync(databasePath, 0o600); } catch { /* Windows permissions are enforced by the trusted runtime root. */ }
    }
    const opened = lstatSync(databasePath);
    if (opened.isSymbolicLink() || !opened.isFile()
      || !samePathIdentity(realpathSync.native(databasePath), databasePath)) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (uid === undefined || opened.uid !== uid || (opened.mode & 0o777) !== 0o600) {
        return { kind: "unavailable", reason: "unsafe-path" };
      }
    }

    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    const value = work();
    database.exec("COMMIT");
    transactionOpen = false;
    return { kind: "completed", value };
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases it */ }
    }
    if (isBusy(error)) return { kind: "unavailable", reason: "busy" };
    throw error;
  } finally {
    try { database?.close(); } catch { /* acquisition already settled */ }
  }
}
