import { describe, expect, test } from "bun:test";
import {
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
  getAdapterDefinition,
} from "../src/adapters/registry";
import { resolveAdapter } from "../src/server/adapter-resolve";
import type { OcxProviderConfig } from "../src/types";

const EXPECTED_ADAPTER_NAMES = {
  "command-code": "command-code",
  "openai-chat": "openai-chat",
  anthropic: "anthropic",
  "openai-responses": "openai-responses",
  google: "google",
  kiro: "kiro",
  azure: "azure-openai",
  "azure-openai": "azure-openai",
  cursor: "cursor",
  "mimo-free": "mimo-free",
} as const;

function provider(adapter: string): OcxProviderConfig {
  return {
    adapter,
    baseUrl: "https://example.invalid/v1",
    authMode: "key",
    apiKey: "test-key",
    defaultMaxOutputTokens: 4096,
  } as OcxProviderConfig;
}

describe("adapter registry authority", () => {
  test("enumerates every production adapter exactly once", () => {
    expect(adapterDefinitions().map(([id]) => id)).toEqual(Object.keys(EXPECTED_ADAPTER_NAMES));
  });

  test("records semantic inheritance without forcing constructor wrapping", () => {
    expect(getAdapterDefinition("azure")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("azure-openai")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("mimo-free")?.contractParent).toBe("openai-chat");

    expect(effectiveAdapterContract("azure").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("azure-openai").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("mimo-free").wire).toBe("openai-chat");
    expect(effectiveAdapterContract("cursor").mutation).toBe("codex-owned-with-gated-native-fallback");
  });

  test("constructs every current adapter with its existing observable identity", () => {
    for (const [adapterId, expectedName] of Object.entries(EXPECTED_ADAPTER_NAMES)) {
      expect(createRegisteredAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
      expect(resolveAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
    }
  });

  test("rejects unknown persisted adapter ids at the runtime boundary", () => {
    expect(() => createRegisteredAdapter(provider("not-a-real-adapter")))
      .toThrow("Unknown adapter: not-a-real-adapter");
    expect(() => effectiveAdapterContract("not-a-real-adapter"))
      .toThrow("Unknown adapter: not-a-real-adapter");
  });
});
