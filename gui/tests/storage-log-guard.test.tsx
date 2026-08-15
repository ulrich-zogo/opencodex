import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

function report(): StorageReport {
  return {
    codexHome: "/home/user/.codex",
    generatedAt: 1,
    total: { bytes: 1024, fileCount: 1 },
    buckets: [],
    codexLogs: {
      generatedAt: 1,
      sqliteHome: "/state/codex",
      databasePath: "/state/codex/logs_2.sqlite",
      externalSqliteHome: true,
      snapshot: "checkpointed",
      files: { databaseBytes: 8192, walBytes: 2048, shmBytes: 0 },
      schema: { state: "compatible" },
      capabilities: {
        inspection: { state: "supported" },
        protection: { state: "supported" },
        reclaim: { state: "supported" },
      },
      metrics: {
        totalRows: 400,
        rowsByLevel: { TRACE: 200, INFO: 200 },
        traceRows: 200,
        traceShare: 0.5,
        topTargets: [{ target: "codex_api::sse", rows: 180 }],
        pageSize: 4096,
        pageCount: 2,
        freelistPages: 1,
        reclaimableBytes: 4096,
        estimatedLogBytes: 350,
      },
    },
  };
}

test("Storage overview renders read-only Codex diagnostic log health", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <StorageWorkspace report={report()} locale="en-US" />
    </LanguageProvider>,
  );

  expect(html).toContain('data-testid="codex-log-guard"');
  expect(html).toContain("Codex diagnostic logs");
  expect(html).toContain("Compatible");
  expect(html).toContain("400");
  expect(html).toContain("50.0%");
  expect(html).toContain("8.0 KiB");
  expect(html).toContain("2.0 KiB");
  expect(html).toContain("4.0 KiB");
  expect(html).toContain("codex_api::sse");
  expect(html).toContain("external sqlite_home");
  expect(html).not.toContain("Protect");
  expect(html).not.toContain("Compact");
  expect(html).not.toContain("High write activity");
});

test("Storage overview makes unknown schemas visibly inspect-only", () => {
  const value = report();
  value.codexLogs = {
    ...value.codexLogs!,
    schema: { state: "unsupported", reason: "unknown_schema" },
    capabilities: {
      inspection: { state: "supported" },
      protection: { state: "unsupported", reason: "unknown_schema" },
      reclaim: { state: "unsupported", reason: "unknown_schema" },
    },
  };

  const html = renderToStaticMarkup(
    <LanguageProvider>
      <StorageWorkspace report={value} locale="en-US" />
    </LanguageProvider>,
  );

  expect(html).toContain("Unknown schema");
  expect(html).toContain("Inspection only");
});
