import { describe, expect, test } from "bun:test";
import { adapterDefinitions, createRegisteredAdapter, effectiveAdapterContract, type AdapterWire } from "../src/adapters/registry";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const PATCH = `*** Begin Patch
*** Add File: buffered-안녕.txt
+quote: "double"
+slash: \\ path
+unicode: 世界
*** End Patch`;

const WIRE_MODELS: Record<AdapterWire, string> = {
  "openai-chat": "grok-4.6",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.5-flash",
  "command-code": "deepseek/deepseek-v4-flash",
  kiro: "claude-sonnet-4.5",
  "openai-responses": "deepseek-v4-flash",
  cursor: "cursor/auto",
};

function providerFixture(adapterId: string, wire: AdapterWire): OcxProviderConfig {
  const baseUrls: Record<AdapterWire, string> = {
    "openai-chat": "https://api.x.ai/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    "command-code": "https://api.commandcode.ai",
    kiro: "https://runtime.us-east-1.kiro.dev",
    "openai-responses": "https://api.deepseek.com",
    cursor: "https://api2.cursor.sh",
  };
  const baseUrl = adapterId === "mimo-free"
    ? "https://api.xiaomimimo.com/api/free-ai/openai"
    : adapterId === "azure" || adapterId === "azure-openai"
      ? "https://example.openai.azure.com/openai/v1"
      : baseUrls[wire];
  return {
    adapter: adapterId,
    baseUrl,
    authMode: wire === "anthropic" || wire === "command-code" ? "oauth" : "key",
    apiKey: wire === "kiro" ? "ksk_test" : "test-key",
    defaultMaxOutputTokens: 64_000,
    googleMode: "ai-studio",
    ...(wire === "openai-responses" ? { responsesPath: "/responses" } : {}),
  } as OcxProviderConfig;
}

function parsed(wire: AdapterWire) {
  const value = parseRequest({
    model: WIRE_MODELS[wire],
    input: "Apply the exact patch.",
    stream: false,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  if (wire === "kiro") value._kiroAuthContext = { apiRegion: "us-east-1" };
  return value;
}

function bufferedResponse(wire: AdapterWire, wireName = "apply_patch"): Response | undefined {
  const args = { input: PATCH };
  if (wire === "openai-chat") {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_buffered_patch",
            type: "function",
            function: { name: wireName, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }
  if (wire === "anthropic") {
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "call_buffered_patch", name: wireName, input: args }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  }
  if (wire === "google") {
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ functionCall: { name: wireName, args } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
  }
  return undefined;
}

function restoredInput(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const call = output.find(item =>
    item && typeof item === "object"
    && (item as Record<string, unknown>).type === "custom_tool_call"
    && (item as Record<string, unknown>).name === "apply_patch"
  ) as Record<string, unknown> | undefined;
  return typeof call?.input === "string" ? call.input : undefined;
}

describe("registry-derived buffered tool conformance", () => {
  test("every buffered parser restores hostile freeform input exactly", async () => {
    let covered = 0;
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const response = bufferedResponse(contract.wire);
      if (!response) continue;
      const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
      if (!adapter.parseResponse) continue;
      covered += 1;

      const request = parsed(contract.wire);
      const events = await adapter.parseResponse(response, createTestTranslatorBudget());
      const maps = buildToolBridgeMaps(request);
      const built = buildResponseJSON(events, request.modelId, {
        toolNsMap: maps.toolNsMap,
        declaredToolNames: maps.declaredToolNames,
        freeformToolNames: maps.freeformToolNames,
        toolSearchToolNames: maps.toolSearchToolNames,
      });
      expect(restoredInput(built.output), adapterId).toBe(PATCH);
    }
    expect(covered).toBeGreaterThan(0);
  });
});
