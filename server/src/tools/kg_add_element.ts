import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Add a typed element node (and optional typed relations) to the project
 * Knowledge Graph. Unlike `store_project_data` (a flat key/value row), the KG
 * is a typed, schema-validated graph of the model: walls, levels, types,
 * openings and the edges between them. Use `kg_query` to read it back.
 */
export function registerKgAddElementTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_add_element",
    "Add a typed element to the project Knowledge Graph (graph-backed project memory, an alternative to the flat store_*_data tools). Validates against the KG schema; can attach typed relations (e.g. at_level, is_type). Returns the allocated llm_id and the turn.",
    {
      node_type: z
        .string()
        .describe(
          "KG node type, e.g. Level, Wall, WallType, Door, Window, Room (call kg_query with what omitted, or see kg schema)."
        ),
      attrs: z
        .record(z.any())
        .describe(
          "Attributes for the node type's required/optional schema, e.g. {name, elevation} for Level."
        ),
      llm_id: z
        .string()
        .optional()
        .describe("Explicit stable id. If omitted, the KG allocates one (e.g. wall_001)."),
      edges: z
        .array(
          z.object({
            type: z
              .string()
              .describe("Edge type: at_level, is_type, hosts, bounded_by, connects_at, derived_from"),
            to: z.string().optional().describe("Target llm_id for an outgoing edge (this -> to)"),
            from: z.string().optional().describe("Source llm_id for an incoming edge (from -> this)"),
          })
        )
        .optional()
        .describe("Typed relations to create alongside the node. Endpoints must already exist."),
      project_id: z
        .string()
        .optional()
        .describe("Project KG id (default: 'default'). The graph persists per project across sessions."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("add_element", {
          project_id: args.project_id,
          node_type: args.node_type,
          attrs: args.attrs ?? {},
          llm_id: args.llm_id,
          edges: args.edges ?? [],
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
