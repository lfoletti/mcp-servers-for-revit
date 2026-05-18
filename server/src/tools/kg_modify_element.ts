import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Modify one OR many nodes' attributes, in ONE atomic transaction / one
 * turn. List-native by design (1..N) — a single edit is a 1-item list, there
 * is no separate "_many" tool. Every modification is recorded as an
 * action-grained history entry (queryable via kg_diff_since). If any edit is
 * invalid the whole batch rolls back. For predicate-targeted bulk edits
 * ("set X for every Y where Z") use kg_modify_where instead.
 */
export function registerKgModifyElementTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_modify_element",
    "Update attributes of one or more Knowledge Graph nodes. Pass `edits` as a list of {llm_id, updates} — one or many, applied atomically in one transaction (all-or-nothing) and one turn. Records per-action history (before/after) so kg_diff_since reports exactly what changed. Schema-validated. Prefer one call with many edits over looping; for 'modify all nodes matching a predicate' use kg_modify_where.",
    {
      edits: z
        .array(
          z.object({
            llm_id: z.string().describe("The node to modify."),
            updates: z
              .record(z.any())
              .describe(
                "Attributes to set, restricted to the node type's schema."
              ),
          })
        )
        .describe("Edits to apply (1..N), atomically in order."),
      project_id: z
        .string()
        .optional()
        .describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("modify_element", {
          project_id: args.project_id,
          edits: args.edits ?? [],
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
