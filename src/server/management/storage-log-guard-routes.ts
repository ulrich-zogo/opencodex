import { inspectCodexLogs } from "../../codex/log-guard/inspect";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/** Read-only Codex Log Guard management surface. Mutation endpoints arrive in PR 2/3. */
export async function handleStorageLogGuardRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/storage/codex-logs" || req.method !== "GET") return null;

  try {
    return jsonResponse(inspectCodexLogs(), 200, req, config);
  } catch (error) {
    return jsonResponse({
      error: "inspect_failed",
      message: error instanceof Error ? error.message : String(error),
    }, 500, req, config);
  }
}
