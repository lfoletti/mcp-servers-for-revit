import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Multi-hop traversal in the KG v2. Forwards to the `kg_traverse` command. */
export function registerKgTraverseTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_traverse",
    "Multi-hop traversal in the KG v2 from start_id. Either give an explicit `path` of {edge_type, direction (out|in)} steps, OR a breadth-first walk via edge_types[] + max_depth + direction (out|in|any). Returns the reached node set (deduped). Read-only.",
    {
      start_id: z.string().describe("llm_id of the node to start from."),
      path: z
        .array(
          z.object({
            edge_type: z.string().describe("Edge type for this step."),
            direction: z.enum(["out", "in"]).optional().describe("Step direction (default out)."),
          })
        )
        .optional()
        .describe("Explicit ordered steps. Takes precedence over edge_types/max_depth."),
      edge_types: z
        .array(z.string())
        .optional()
        .describe("Edge types allowed during a breadth-first walk (empty = any)."),
      max_depth: z
        .number()
        .int()
        .optional()
        .describe("Max hops for the breadth-first walk (default 8)."),
      direction: z
        .enum(["out", "in", "any"])
        .optional()
        .describe("Walk direction (default any)."),
      include_soft_deleted: z
        .boolean()
        .optional()
        .describe("Include soft-deleted nodes (default false)."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_traverse", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
