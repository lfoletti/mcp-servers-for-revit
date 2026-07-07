import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Return KG v2 action-log entries since a given turn. Forwards to the
 * `kg_diff_since` socket command (RevitMCPKgCommandSet). Read-only.
 */
export function registerKgDiffSinceTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_diff_since",
    "Return KG v2 action log entries since a given turn (create/modify/delete/etc.). Read-only. Feed only the delta as context instead of re-reading the whole model.",
    {
      since_turn: z
        .number()
        .int()
        .optional()
        .describe("Return actions with turn >= this value (default 0 = full history)."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_diff_since", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
