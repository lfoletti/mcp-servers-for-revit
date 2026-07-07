import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Search the Revit-side KG v2 projection. Forwards to the `kg_query` socket
 * command (RevitMCPKgCommandSet). Read-only.
 */
export function registerKgQueryTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_query",
    "Search KG v2 nodes by type and/or attrs_filter (exact match). Read-only. Returns matching nodes with their attrs and lifecycle. Supports select (project attributes), aggregate ({op, field, group_by}) and join (follow typed edges).",
    {
      node_type: z.string().optional().describe("Filter to one node type, e.g. Wall."),
      include_soft_deleted: z
        .boolean()
        .optional()
        .describe("Include soft-deleted (tombstoned) nodes (default false)."),
      attrs_filter: z
        .record(z.any())
        .optional()
        .describe("Exact-match attribute filter, e.g. { \"Level\": \"L1\" }."),
      select: z
        .array(z.string())
        .optional()
        .describe("Project only these attribute keys instead of the full node."),
      aggregate: z
        .object({
          op: z.string().describe("count | sum | avg | min | max"),
          field: z.string().optional().describe("Attribute to aggregate (not needed for count)."),
          group_by: z.string().optional().describe("Attribute to group results by."),
        })
        .optional()
        .describe("Aggregate over the matched nodes."),
      join: z
        .array(
          z.object({
            edge_type: z.string().describe("Edge type to follow, e.g. at_level."),
            direction: z.enum(["out", "in"]).optional().describe("Edge direction (default out)."),
            as: z.string().optional().describe("Alias for the joined node set."),
            select: z.array(z.string()).optional().describe("Attributes to project from joined nodes."),
          })
        )
        .optional()
        .describe("Follow typed edges from each matched node."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_query", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
