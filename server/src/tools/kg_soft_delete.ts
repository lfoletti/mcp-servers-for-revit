import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Soft-delete one OR many nodes, in ONE atomic transaction / one turn.
 * List-native by design (1..N), like the upstream `delete_element(string[])`.
 * Each node is flagged with deleted_at_turn and excluded from normal
 * queries, but retained for history and undo — never a silent hard delete.
 */
export function registerKgSoftDeleteTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_soft_delete",
    "Soft-delete one or more Knowledge Graph nodes (sets deleted_at_turn, hides them from default queries, keeps them for history/undo). Pass `llm_ids` as a list — one or many, atomically in one transaction and one turn. Reversible by design — unlike a hard row delete in the flat store.",
    {
      llm_ids: z
        .array(z.string())
        .describe("Node ids to soft-delete (1..N), atomically."),
      project_id: z
        .string()
        .optional()
        .describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("soft_delete", {
          project_id: args.project_id,
          llm_ids: args.llm_ids ?? [],
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
