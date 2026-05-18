import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Modify a node's attributes. Every modification is recorded as an
 * action-grained history entry (queryable via kg_diff_since) — not an
 * in-place overwrite that loses what changed.
 */
export function registerKgModifyElementTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_modify_element",
    "Update attributes of a Knowledge Graph node. Records a per-action history entry (before/after) so kg_diff_since can report exactly what changed since a given turn. Schema-validated against the node type.",
    {
      llm_id: z.string().describe("The node to modify."),
      updates: z
        .record(z.any())
        .describe("Attributes to set, restricted to the node type's schema."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("modify_element", {
          project_id: args.project_id,
          llm_id: args.llm_id,
          updates: args.updates,
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
