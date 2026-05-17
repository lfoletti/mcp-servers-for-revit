import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgBridge, kgResult, kgError } from "../kg/bridge.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Soft-delete a node: it is flagged with deleted_at_turn and excluded from
 * normal queries, but retained for history and undo. Destructive deletion is
 * never silent — the opposite of dropping a row.
 */
export function registerKgSoftDeleteTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_soft_delete",
    "Soft-delete a Knowledge Graph node (sets deleted_at_turn, hides it from default queries, keeps it for history/undo). Reversible by design — unlike a hard row delete in the flat store.",
    {
      llm_id: z.string().describe("The node to soft-delete."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgBridge.call("soft_delete", {
          project_id: args.project_id,
          llm_id: args.llm_id,
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
