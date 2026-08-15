import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, I18nContext, interpolate, type TFn } from "../src/i18n/shared";

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

function germanT(): TFn {
  return (key, vars) => interpolate(DICTS.de[key] ?? DICTS.en[key] ?? key, vars);
}

test("Storage overview renders read-only Codex diagnostic log health", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <StorageWorkspace report={report()} locale="en" />
    </LanguageProvider>,
  );

  expect(html).toContain('data-testid="codex-log-guard"');
  expect(html).toContain("Logs database");
  expect(html).toContain("compatible");
  expect(html).toContain("400");
  expect(html).toContain("50.0%");
  expect(html).toContain("8 KB");
  expect(html).toContain("2 KB");
  expect(html).toContain("4 KB");
  expect(html).toContain("codex_api::sse");
  expect(html).toContain("snapshot=checkpointed");
  expect(html).not.toContain("/state/codex");
  expect(html).not.toContain("Protect");
  expect(html).not.toContain("Compact");
  expect(html).not.toContain("High write activity");
});

test("Storage overview localizes external and inspect-only labels", () => {
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
    <I18nContext.Provider value={{ locale: "de", setLocale: () => {}, t: germanT() }}>
      <StorageWorkspace report={value} locale="de" />
    </I18nContext.Provider>,
  );

  expect(html).toContain("unsupported");
  expect(html).toContain("Nur Inspektion");
  expect(html).toContain("Externer SQLite-Speicher");
  expect(html).not.toContain("inspection-only");
  expect(html).not.toContain("external sqlite_home");
  expect(html).not.toContain("/state/codex");
});
