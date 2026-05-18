import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Add one OR many typed element nodes (and their typed relations) to the
 * project Knowledge Graph, in ONE atomic transaction / one turn. List-native
 * by design (1..N), like the upstream Revit commands (`create_level` takes a
 * `List<…>`): a single element is just a 1-item list — there is no separate
 * "_many" tool. If any item is invalid the whole batch rolls back.
 */
export function registerKgAddElementTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_add_element",
    "Add one or more typed elements to the project Knowledge Graph (graph-backed project memory; alternative to the flat store_*_data tools). Pass `elements` as a list — one item or many, created atomically in one transaction (all-or-nothing) and one turn. Validates against the KG schema; can attach typed relations (at_level, is_type, hosts, …). Prefer a single call with many elements over looping. Returns a compact id summary + the turn.",
    {
      elements: z
        .array(
          z.object({
            node_type: z
              .string()
              .describe(
                "KG node type, e.g. Level, Wall, WallType, Door, Window, Room."
              ),
            attrs: z
              .record(z.any())
              .describe(
                "Attributes for the node type's required/optional schema, e.g. {name, elevation} for Level."
              ),
            llm_id: z
              .string()
              .optional()
              .describe(
                "Explicit stable id. If omitted, the KG allocates one (e.g. wall_001)."
              ),
            edges: z
              .array(
                z.object({
                  type: z
                    .string()
                    .describe(
                      "Edge type: at_level, is_type, hosts, bounded_by, connects_at, derived_from"
                    ),
                  to: z
                    .string()
                    .optional()
                    .describe("Target llm_id for an outgoing edge (this -> to)"),
                  from: z
                    .string()
                    .optional()
                    .describe("Source llm_id for an incoming edge (from -> this)"),
                })
              )
              .optional()
              .describe(
                "Typed relations to create alongside this node. Endpoints must already exist (or be created earlier in this same list)."
              ),
          })
        )
        .describe("Elements to create (1..N), atomically in order."),
      project_id: z
        .string()
        .optional()
        .describe(
          "Project KG id (default: 'default'). The graph persists per project across sessions."
        ),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("add_element", {
          project_id: args.project_id,
          elements: args.elements ?? [],
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
