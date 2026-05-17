import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgBridge, kgResult, kgError } from "../kg/bridge.js";

/**
 * Demonstrates the KG's all-or-nothing transaction: a batch whose last
 * operation is invalid is fully rolled back (no node, no turn bump, no log
 * entry survives). This is the KG half of the production `@kg_synced`
 * contract — the same guarantee that, when a batch also mutates Revit,
 * prevents the model and the project memory from silently diverging.
 */
export function registerKgTransactionDemoTool(server: McpServer) {
  server.tool(
    "kg_transaction_demo",
    "Run a multi-operation batch inside one KG transaction where the last op fails, and show that the graph rolled back completely (before == after). Illustrates atomicity the flat store lacks: there, the first writes would have committed, leaving project memory half-applied.",
    {
      ops: z
        .array(
          z.object({
            node_type: z.string(),
            attrs: z.record(z.any()).optional(),
          })
        )
        .optional()
        .describe(
          "Optional custom batch. If omitted, a default batch (two valid Levels + one invalid node type) is used."
        ),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgBridge.call("transaction_demo", {
          project_id: args.project_id,
          ops: args.ops,
        });
        return kgResult(result);
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
