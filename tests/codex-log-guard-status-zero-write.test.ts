import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCodexLogGuardProtectionStatus } from "../src/codex/log-guard/protection";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { codexHome: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-status-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const databasePath = join(codexHome, "logs_2.sqlite");
  const db = new Database(databasePath);
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
    INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes)
      VALUES (1, 0, 'TRACE', 'codex_api::sse', 'PRIVATE', 10);
  `);
  db.close();
  return { codexHome, databasePath };
}

describe("Codex Log Guard status remains zero-write", () => {
  test("status does not change the DB or materialise WAL/SHM sidecars", () => {
    const { codexHome, databasePath } = fixture();
    const before = statSync(databasePath);
    const wal = `${databasePath}-wal`;
    const shm = `${databasePath}-shm`;
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(shm)).toBe(false);

    const status = getCodexLogGuardProtectionStatus({
      codexHome,
      readDesiredMode: () => "off",
    });

    expect(status.protection).toEqual({ desiredMode: "off", observedMode: "off", state: "off" });
    const after = statSync(databasePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(shm)).toBe(false);
  });
});
