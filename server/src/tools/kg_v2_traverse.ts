import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV2, mcpResult, mcpError } from "../kg-v2/client.js";
import { kgV2ToolsEnabled, logKgV2ModeOnce } from "../kg-v2/mode.js";

const StepSchema = z.object({
  edge_type: z.string().describe("at_level | is_type | hosts | bounded_by | connects_at | derived_from"),
  direction: z
    .enum(["out", "in"])
    .optional()
    .describe("'out' = follow edge from src→dst (default), 'in' = reverse"),
});

export function registerKgV2TraverseTool(server: McpServer) {
  logKgV2ModeOnce();
  if (!kgV2ToolsEnabled()) return;
  server.tool(
    "kg_v2_traverse",
    "Multi-hop traversal in the KG v2 from start_id following a path of {edge_type, direction (out|in)} steps. Returns the deduped set of nodes reached after the last hop. Soft-deleted nodes are included if their edges still wire them (audit-trail behavior, DESIGN §6). Empty path returns the start node alone.",
    {
      start_id: z.string().describe("Starting llm_id (e.g. wall_001)."),
      path: z
        .array(StepSchema)
        .optional()
        .describe("Sequence of edge-following steps. Empty/omitted → return start only."),
    },
    async (args: any) => {
      try {
        const r = await callV2<unknown>("kg_traverse", {
          start_id: args.start_id,
          path: args.path ?? [],
        });
        return mcpResult(r);
      } catch (e) {
        return mcpError(e);
      }
    }
  );
}
