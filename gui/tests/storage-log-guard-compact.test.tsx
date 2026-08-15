/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import StorageWorkspace, { type StorageReport } from "../src/components/storage-workspace/StorageWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (active) {
    const root = active;
    active = null;
    await act(async () => { root.unmount(); });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

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

async function mount(value: StorageReport, onAction: (action: unknown) => void): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <StorageWorkspace report={value} locale="en" onLogGuardAction={onAction} />
      </LanguageProvider>,
    );
  });
  return container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); });
}

test("compact requires an explicit second confirmation before emitting the mutation action", async () => {
  const actions: unknown[] = [];
  const container = await mount(report(), action => actions.push(action));

  const compact = container.querySelector<HTMLElement>('[data-testid="log-guard-compact"]');
  expect(compact).not.toBeNull();
  if (!compact) return;
  await click(compact);
  expect(actions).toEqual([]);

  const confirm = container.querySelector<HTMLElement>('[data-testid="log-guard-compact-confirm"]');
  expect(confirm).not.toBeNull();
  if (!confirm) return;
  await click(confirm);
  expect(actions).toEqual([{ action: "compact" }]);
});

test("compact is hidden when the snapshot reports no reclaimable space", async () => {
  const container = await mount(report(0), () => {});
  expect(container.querySelector('[data-testid="log-guard-compact"]')).toBeNull();
});

test("compact is hidden when reclaim is unsupported", async () => {
  const value = report();
  value.codexLogs = {
    ...value.codexLogs!,
    capabilities: {
      ...value.codexLogs!.capabilities,
      reclaim: { state: "unsupported", reason: "unknown_schema" },
    },
  };
  const container = await mount(value, () => {});
  expect(container.querySelector('[data-testid="log-guard-compact"]')).toBeNull();
});
