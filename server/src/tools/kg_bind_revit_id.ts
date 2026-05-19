import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Bind one OR many KG nodes to real Revit ElementIds (the
 * `ElementId.Value` returned by the create_* commands). List-native
 * (1..N), atomic. Framework metadata: it does NOT bump the turn nor add
 * an action_log entry (a binding is not a project mutation — keeping
 * turn/diff_since semantics intact). The bound id then shows in
 * kg_query node attrs, enabling KG↔model cross-check and out-of-band
 * drift detection (kg node ←→ the actual .rvt element it represents).
 * Typical use: create_line_based_element / create_point_based_element
 * → take each returned ElementId → kg_bind_revit_id(llm_id, revit_id).
 */
export function registerKgBindRevitIdTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_bind_revit_id",
    "Bind one or more existing KG nodes to their real Revit ElementId " +
      "(from a create_* command's returned ElementId). Pass `bindings` " +
      "as a list — one or many, applied atomically (all-or-nothing). " +
      "This is framework metadata: it does NOT advance the turn or log " +
      "an action. After binding, the node's revit id is visible via " +
      "kg_query, so the KG can be cross-checked against the live Revit " +
      "model and out-of-band edits (drift) can be detected.",
    {
      bindings: z
        .array(
          z.object({
            llm_id: z
              .string()
              .describe("The KG node's stable id (e.g. wall_01) to bind."),
            revit_id: z
              .number()
              .describe(
                "The Revit ElementId.Value (integer) of the real element " +
                  "this node represents, as returned by a create_* command."
              ),
          })
        )
        .describe("Bindings to apply (1..N), atomically."),
      project_id: z
        .string()
        .optional()
        .describe(
          "Project KG id (default: 'default'). Persists per project."
        ),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("bind_revit_id", {
          project_id: args.project_id,
          bindings: args.bindings ?? [],
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
