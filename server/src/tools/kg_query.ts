import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgBridge, kgResult, kgError } from "../kg/bridge.js";

/**
 * Query the typed project graph: nodes filtered by type/id, with their typed
 * relations. Soft-deleted nodes are hidden unless explicitly requested — the
 * flat store has no concept of either a relation or a lifecycle.
 */
export function registerKgQueryTool(server: McpServer) {
  server.tool(
    "kg_query",
    "Query the project Knowledge Graph: typed nodes and the relations between them. Filter by node_type and/or llm_id. Hides soft-deleted nodes unless include_deleted=true. This answers structural questions (what is hosted by what, at which level) that a flat key/value store cannot.",
    {
      node_type: z.string().optional().describe("Filter to one node type, e.g. Wall."),
      llm_id: z.string().optional().describe("Fetch a single node by id."),
      include_deleted: z
        .boolean()
        .optional()
        .describe("Include soft-deleted nodes (default false)."),
      include_edges: z
        .boolean()
        .optional()
        .describe("Include relations touching the matched nodes (default true)."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgBridge.call("query", {
          project_id: args.project_id,
          node_type: args.node_type,
          llm_id: args.llm_id,
          include_deleted: args.include_deleted ?? false,
          include_edges: args.include_edges ?? true,
        });
        return kgResult(result);
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
