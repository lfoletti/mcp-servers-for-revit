import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV2, mcpResult, mcpError } from "../kg-v2/client.js";
import { kgV2ToolsEnabled, logKgV2ModeOnce } from "../kg-v2/mode.js";

export function registerKgV2QueryTool(server: McpServer) {
  logKgV2ModeOnce();
  if (!kgV2ToolsEnabled()) return;
  server.tool(
    "kg_v2_query",
    "Query KG v2 nodes by type and/or exact attrs_filter. Read-only projection of the Revit model maintained by the embedded DocumentChanged hook. Returns matching nodes with their attrs and lifecycle. Soft-deleted nodes hidden unless include_soft_deleted=true.",
    {
      node_type: z.string().optional().describe("Filter to one node type (Wall, Level, Window, ...)."),
      attrs_filter: z
        .record(z.unknown())
        .optional()
        .describe("Exact-match attrs filter (numeric coercion int↔double)."),
      include_soft_deleted: z
        .boolean()
        .optional()
        .describe("Include tombstoned nodes (default false)."),
    },
    async (args: any) => {
      try {
        const r = await callV2<unknown>("kg_query", {
          node_type: args.node_type,
          attrs_filter: args.attrs_filter,
          include_soft_deleted: args.include_soft_deleted ?? false,
        });
        return mcpResult(r);
      } catch (e) {
        return mcpError(e);
      }
    }
  );
}
