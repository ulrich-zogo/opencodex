import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { Database, constants as sqliteConstants } from "bun:sqlite";

import { getCodexHome } from "../paths";
import { samePathIdentity } from "../user-identity";
import { inspectCodexLogs } from "./inspect";
import { withCodexLogGuardLock, type CodexLogGuardLockOutcome } from "./lock";
import {
  listRunningCodexProcesses,
  type CodexWriterProcessCheck,
} from "./processes";

const CURRENT_LOG_COLUMNS = [
  "id",
  "ts",
  "ts_nanos",
  "level",
  "target",
  "feedback_log_body",
  "module_path",
  "file",
  "line",
  "thread_id",
  "process_uuid",
  "estimated_bytes",
] as const;

const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_RUN = 256 * 1024 * 1024;
const MAX_ITERATIONS = 64;

type CompactStopReason = "complete" | "page_budget" | "no_progress";

export interface CodexLogGuardCompactionMeasure {
  databaseBytes: number;
  walBytes: number;
  pageCount: number;
  freelistPages: number;
  reclaimableBytes: number;
}

export interface CodexLogGuardCompactionReport {
  databasePath: string;
  pageSize: number;
  before: CodexLogGuardCompactionMeasure;
  after: CodexLogGuardCompactionMeasure;
  pagesReclaimed: number;
  logicalBytesReclaimed: number;
  physicalDatabaseBytesReclaimed: number;
  iterations: number;
  complete: boolean;
  stopReason: CompactStopReason;
  integrity: { before: "ok"; after: "ok" };
}

export type CodexLogGuardCompactionError =
  | "unsupported_schema"
  | "auto_vacuum_not_incremental"
  | "codex_running"
  | "process_enumeration_failed"
  | "busy"
  | "unsafe_path"
  | "integrity_check_failed"
  | "database_error";

export type CodexLogGuardCompactionResult =
  | { ok: true; report: CodexLogGuardCompactionReport }
  | { ok: false; error: Exclude<CodexLogGuardCompactionError, "integrity_check_failed"> }
  | { ok: false; error: "integrity_check_failed"; phase: "before" | "after" };

export interface CodexLogGuardMaintenanceDeps {
  codexHome?: string;
  processCheck?: () => CodexWriterProcessCheck;
  withLock?: <T>(
    canonicalCodexHome: string,
    canonicalLogsDbPath: string,
    work: () => T,
  ) => CodexLogGuardLockOutcome<T>;
  quickCheck?: (db: Database) => string[];
  batchPages?: number;
  maxPagesPerRun?: number;
}

interface ColumnRow { name: string }
interface CheckpointRow {
  busy?: number;
  log?: number;
  checkpointed?: number;
}

function isBusy(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function databasePathIsSafe(databasePath: string): boolean {
  try {
    const stat = lstatSync(databasePath);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && samePathIdentity(realpathSync.native(databasePath), databasePath);
  } catch {
    return false;
  }
}

function exactCurrentSchema(db: Database): boolean {
  const columns = db.query<ColumnRow, []>("PRAGMA table_info(logs)").all().map(row => row.name).sort();
  const expected = [...CURRENT_LOG_COLUMNS].sort();
  return columns.length === expected.length
    && columns.every((value, index) => value === expected[index]);
}

function pragmaNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, []>(sql).get();
  if (!row) throw new Error(`missing pragma result for ${sql}`);
  const value = Number(Object.values(row)[0]);
  if (!Number.isFinite(value)) throw new Error(`invalid pragma result for ${sql}`);
  return value;
}

function defaultQuickCheck(db: Database): string[] {
  return db.query<Record<string, unknown>, []>("PRAGMA quick_check").all().map(row => {
    const value = Object.values(row)[0];
    return value === undefined ? "" : String(value);
  });
}

function quickCheckIsOk(rows: string[]): boolean {
  return rows.length === 1 && rows[0]?.trim().toLowerCase() === "ok";
}

function processRefusal(check: CodexWriterProcessCheck): CodexLogGuardCompactionError | null {
  if (check.state === "unknown") return "process_enumeration_failed";
  if (check.processes.length > 0) return "codex_running";
  return null;
}

function checkpointFull(db: Database): "ok" | "busy" {
  const row = db.query<CheckpointRow, []>("PRAGMA wal_checkpoint(FULL)").get();
  if (!row) throw new Error("missing wal_checkpoint result");
  const values = Object.values(row).map(Number);
  const busy = Number(row.busy ?? values[0] ?? 0);
  const log = Number(row.log ?? values[1] ?? -1);
  const checkpointed = Number(row.checkpointed ?? values[2] ?? -1);
  if (busy !== 0) return "busy";
  // SQLite returns -1/-1 when the database is not in WAL mode or there are no
  // WAL frames to report. Otherwise FULL must have copied every frame.
  if (log >= 0 && checkpointed >= 0 && checkpointed < log) return "busy";
  return "ok";
}

function walBytes(databasePath: string): number {
  const path = `${databasePath}-wal`;
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function measure(db: Database, databasePath: string, pageSize: number): CodexLogGuardCompactionMeasure {
  const pageCount = pragmaNumber(db, "PRAGMA page_count");
  const freelistPages = pragmaNumber(db, "PRAGMA freelist_count");
  return {
    databaseBytes: statSync(databasePath).size,
    walBytes: walBytes(databasePath),
    pageCount,
    freelistPages,
    reclaimableBytes: freelistPages * pageSize,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid Log Guard page budget");
  return value;
}

function runCompaction(
  databasePath: string,
  deps: CodexLogGuardMaintenanceDeps,
): CodexLogGuardCompactionResult {
  let db: Database | undefined;
  let probeOpen = false;
  try {
    if (!databasePathIsSafe(databasePath)) return { ok: false, error: "unsafe_path" };
    db = new Database(databasePath, sqliteConstants.SQLITE_OPEN_READWRITE);
    db.exec("PRAGMA busy_timeout = 0");

    // Fail fast if any external writer still owns the target database. The
    // transaction itself does no maintenance and is rolled back immediately.
    db.exec("BEGIN IMMEDIATE");
    probeOpen = true;
    db.exec("ROLLBACK");
    probeOpen = false;

    if (!exactCurrentSchema(db)) return { ok: false, error: "unsupported_schema" };
    if (pragmaNumber(db, "PRAGMA auto_vacuum") !== 2) {
      return { ok: false, error: "auto_vacuum_not_incremental" };
    }

    const quickCheck = deps.quickCheck ?? defaultQuickCheck;
    if (!quickCheckIsOk(quickCheck(db))) {
      return { ok: false, error: "integrity_check_failed", phase: "before" };
    }

    if (checkpointFull(db) === "busy") return { ok: false, error: "busy" };

    const pageSize = pragmaNumber(db, "PRAGMA page_size");
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("invalid page size");
    const batchPages = positiveInteger(
      deps.batchPages,
      Math.max(1, Math.floor(DEFAULT_BATCH_BYTES / pageSize)),
    );
    const maxPagesPerRun = positiveInteger(
      deps.maxPagesPerRun,
      Math.max(1, Math.floor(DEFAULT_MAX_BYTES_PER_RUN / pageSize)),
    );

    const before = measure(db, databasePath, pageSize);
    let previousFreelist = before.freelistPages;
    let pagesReclaimed = 0;
    let iterations = 0;
    let stopReason: CompactStopReason = previousFreelist === 0 ? "complete" : "no_progress";

    while (previousFreelist > 0 && iterations < MAX_ITERATIONS) {
      const remainingBudget = maxPagesPerRun - pagesReclaimed;
      if (remainingBudget <= 0) {
        stopReason = "page_budget";
        break;
      }
      const requestPages = Math.max(1, Math.min(batchPages, remainingBudget, previousFreelist));
      db.exec(`PRAGMA incremental_vacuum(${requestPages})`);
      if (checkpointFull(db) === "busy") return { ok: false, error: "busy" };
      iterations += 1;

      const currentFreelist = pragmaNumber(db, "PRAGMA freelist_count");
      const reclaimedThisIteration = Math.max(0, previousFreelist - currentFreelist);
      pagesReclaimed += reclaimedThisIteration;
      if (currentFreelist >= previousFreelist) {
        stopReason = "no_progress";
        previousFreelist = currentFreelist;
        break;
      }
      previousFreelist = currentFreelist;
      if (currentFreelist === 0) {
        stopReason = "complete";
        break;
      }
      if (pagesReclaimed >= maxPagesPerRun) {
        stopReason = "page_budget";
        break;
      }
    }

    if (previousFreelist > 0 && iterations >= MAX_ITERATIONS && stopReason !== "page_budget") {
      stopReason = "no_progress";
    }

    if (!quickCheckIsOk(quickCheck(db))) {
      return { ok: false, error: "integrity_check_failed", phase: "after" };
    }

    // The preceding incremental-vacuum iterations checkpoint after every batch.
    // One final FULL checkpoint makes the reported physical main-DB size reflect
    // the final truncation state as far as SQLite can guarantee offline.
    if (checkpointFull(db) === "busy") return { ok: false, error: "busy" };
    const after = measure(db, databasePath, pageSize);
    const complete = after.freelistPages === 0;
    if (complete) stopReason = "complete";

    return {
      ok: true,
      report: {
        databasePath,
        pageSize,
        before,
        after,
        pagesReclaimed: Math.max(0, before.freelistPages - after.freelistPages),
        logicalBytesReclaimed: Math.max(0, before.freelistPages - after.freelistPages) * pageSize,
        physicalDatabaseBytesReclaimed: Math.max(0, before.databaseBytes - after.databaseBytes),
        iterations,
        complete,
        stopReason,
        integrity: { before: "ok", after: "ok" },
      },
    };
  } catch (error) {
    if (probeOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close releases it */ }
    }
    if (isBusy(error)) return { ok: false, error: "busy" };
    return { ok: false, error: "database_error" };
  } finally {
    try { db?.close(); } catch { /* maintenance already settled */ }
  }
}

export function compactCodexLogs(
  deps: CodexLogGuardMaintenanceDeps = {},
): CodexLogGuardCompactionResult {
  const codexHome = deps.codexHome ?? getCodexHome();
  const inspection = inspectCodexLogs({ codexHome });
  if (inspection.capabilities.reclaim.state !== "supported") {
    return { ok: false, error: "unsupported_schema" };
  }
  if (!databasePathIsSafe(inspection.databasePath)) return { ok: false, error: "unsafe_path" };

  const checkProcesses = deps.processCheck ?? listRunningCodexProcesses;
  const firstRefusal = processRefusal(checkProcesses());
  if (firstRefusal) return { ok: false, error: firstRefusal };

  const withLock = deps.withLock ?? withCodexLogGuardLock;
  let locked: CodexLogGuardLockOutcome<CodexLogGuardCompactionResult>;
  try {
    locked = withLock(codexHome, inspection.databasePath, () => {
      const secondRefusal = processRefusal(checkProcesses());
      if (secondRefusal) return { ok: false as const, error: secondRefusal };
      return runCompaction(inspection.databasePath, deps);
    });
  } catch {
    return { ok: false, error: "database_error" };
  }

  if (locked.kind === "unavailable") {
    return {
      ok: false,
      error: locked.reason === "busy"
        ? "busy"
        : locked.reason === "unsafe-path" ? "unsafe_path" : "database_error",
    };
  }
  return locked.value;
}
