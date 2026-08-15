import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectCodexLogs } from "../src/codex/log-guard/inspect";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-"));
  roots.push(root);
  return root;
}

function createCurrentLogsDb(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_thread_id ON logs(thread_id);
    CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_process_uuid_threadless_ts
      ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
      WHERE thread_id IS NULL;
  `);
  const insert = db.query(`
    INSERT INTO logs (
      ts, ts_nanos, level, target, feedback_log_body,
      module_path, file, line, thread_id, process_uuid, estimated_bytes
    ) VALUES (?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  insert.run(1, "TRACE", "codex_api::sse", "PRIVATE prompt alpha", "proc-a", 100);
  insert.run(2, "TRACE", "codex_api::sse", "PRIVATE prompt beta", "proc-a", 200);
  insert.run(3, "INFO", "codex_core", "PRIVATE info body", "proc-a", 50);
  insert.run(4, "WARN", "codex_core", "PRIVATE warning body", "proc-b", 75);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch {}
  }
}

function snapshotDir(path: string): Map<string, { size: number; mtimeMs: number }> {
  const snapshot = new Map<string, { size: number; mtimeMs: number }>();
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    const stat = statSync(full);
    snapshot.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return snapshot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard inspection", () => {
  test("inspects only canonical logs_2.sqlite from resolved sqlite_home", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const sqliteHome = join(root, "sqlite-home");
    mkdirSync(codexHome);
    mkdirSync(sqliteHome);
    writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
    createCurrentLogsDb(join(sqliteHome, "logs_2.sqlite"));
    // A higher-numbered legacy/future-looking file must never become the canonical target.
    writeFileSync(join(sqliteHome, "logs_99.sqlite"), "not a database");

    const report = inspectCodexLogs({ codexHome });

    expect(report.sqliteHome).toBe(sqliteHome);
    expect(report.databasePath).toBe(join(sqliteHome, "logs_2.sqlite"));
    expect(report.externalSqliteHome).toBe(true);
    expect(report.schema.state).toBe("compatible");
    expect(report.capabilities).toEqual({
      inspection: { state: "supported" },
      protection: { state: "supported" },
      reclaim: { state: "supported" },
    });
    expect(report.metrics?.totalRows).toBe(4);
    expect(report.metrics?.rowsByLevel).toEqual({ INFO: 1, TRACE: 2, WARN: 1 });
    expect(report.metrics?.traceRows).toBe(2);
    expect(report.metrics?.traceShare).toBe(0.5);
    expect(report.metrics?.topTargets[0]).toEqual({ target: "codex_api::sse", rows: 2 });
    expect(report.metrics?.reclaimableBytes).toBeGreaterThanOrEqual(0);
  });

  test("never exposes feedback_log_body or other raw log content", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(join(codexHome, "logs_2.sqlite"));

    const serialized = JSON.stringify(inspectCodexLogs({ codexHome }));

    expect(serialized).not.toContain("PRIVATE prompt alpha");
    expect(serialized).not.toContain("PRIVATE prompt beta");
    expect(serialized).not.toContain("PRIVATE info body");
    expect(serialized).not.toContain("feedback_log_body");
  });

  test("performs zero filesystem writes and does not create WAL/SHM sidecars", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(join(codexHome, "logs_2.sqlite"));
    const before = snapshotDir(codexHome);

    inspectCodexLogs({ codexHome });

    const after = snapshotDir(codexHome);
    expect(after).toEqual(before);
    expect(readdirSync(codexHome)).not.toContain("logs_2.sqlite-wal");
    expect(readdirSync(codexHome)).not.toContain("logs_2.sqlite-shm");
  });

  test("monitors an unknown future schema but refuses mutation capabilities", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(join(codexHome, "logs_2.sqlite"));
    const db = new Database(join(codexHome, "logs_2.sqlite"));
    db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema.state).toBe("unsupported");
    expect(report.schema.reason).toBe("unknown_schema");
    expect(report.metrics?.totalRows).toBe(4);
    expect(report.capabilities.inspection).toEqual({ state: "supported" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("reports a missing canonical database without falling back to logs_N", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(join(codexHome, "logs_3.sqlite"), "future-looking file");

    const report = inspectCodexLogs({ codexHome });

    expect(report.databasePath).toBe(join(codexHome, "logs_2.sqlite"));
    expect(report.schema).toEqual({ state: "missing", reason: "database_missing" });
    expect(report.metrics).toBeNull();
    expect(report.files).toEqual({ databaseBytes: 0, walBytes: 0, shmBytes: 0 });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_missing" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_missing" });
  });

  test("degrades unreadable databases to inspectable metadata instead of throwing", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(join(codexHome, "logs_2.sqlite"), "not sqlite");

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unreadable", reason: "database_unreadable" });
    expect(report.files.databaseBytes).toBeGreaterThan(0);
    expect(report.metrics).toBeNull();
    expect(report.capabilities.inspection).toEqual({ state: "supported" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_unreadable" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_unreadable" });
  });
});
