import { expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

function report(reclaimableBytes = 65536): StorageReport {
  return {
    codexHome: "/home/user/.codex",
    generatedAt: 1,
    total: { bytes: 1024, fileCount: 1 },
    buckets: [],
    codexLogs: {
      generatedAt: 1,
      sqliteHome: "/home/user/.codex",
      databasePath: "/home/user/.codex/logs_2.sqlite",
      externalSqliteHome: false,
      snapshot: "checkpointed",
      files: { databaseBytes: 8192, walBytes: 0, shmBytes: 0 },
      schema: { state: "compatible" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "supported" },
        reclaim: { state: "supported" },
      },
      protection: { desiredMode: "off", observedMode: "off", state: "off" },
      metrics: {
        totalRows: 10,
        rowsByLevel: { INFO: 10 },
        traceRows: 0,
        traceShare: 0,
        topTargets: [],
        pageSize: 4096,
        pageCount: 100,
        freelistPages: reclaimableBytes === 0 ? 0 : 16,
        reclaimableBytes,
        estimatedLogBytes: null,
      },
    },
  } as StorageReport;
}

function mount(value: StorageReport, onAction: (action: unknown) => void) {
  return render(
    <LanguageProvider>
      <StorageWorkspace report={value} locale="en" onLogGuardAction={onAction} />
    </LanguageProvider>,
  );
}

test("compact requires an explicit second confirmation before emitting the mutation action", () => {
  const actions: unknown[] = [];
  const view = mount(report(), action => actions.push(action));

  const compact = view.getByTestId("log-guard-compact");
  fireEvent.click(compact);
  expect(actions).toEqual([]);
  expect(view.getByTestId("log-guard-compact-confirm")).toBeTruthy();

  fireEvent.click(view.getByTestId("log-guard-compact-confirm"));
  expect(actions).toEqual([{ action: "compact" }]);
});

test("compact is hidden when the snapshot reports no reclaimable space", () => {
  const view = mount(report(0), () => {});
  expect(view.queryByTestId("log-guard-compact")).toBeNull();
});

test("compact is hidden when reclaim is unsupported", () => {
  const value = report();
  value.codexLogs = {
    ...value.codexLogs!,
    capabilities: {
      ...value.codexLogs!.capabilities,
      reclaim: { state: "unsupported", reason: "unknown_schema" },
    },
  };
  const view = mount(value, () => {});
  expect(view.queryByTestId("log-guard-compact")).toBeNull();
});
