import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgBridge, kgResult, kgError } from "../kg/bridge.js";

/**
 * Return the action-grained change log since a given turn (create / modify /
 * delete, with before/after). This is the substrate for token-cheap
 * "what changed" context and for drift reconciliation — structurally
 * impossible against a flat key/value store.
 */
export function registerKgDiffSinceTool(server: McpServer) {
  server.tool(
    "kg_diff_since",
    "List every Knowledge Graph mutation since turn N (create/modify/delete with before/after). Lets an agent feed only the delta as context instead of re-reading the whole model — and is the basis for detecting out-of-band edits (drift). No equivalent exists on the flat store_*_data tools.",
    {
      since_turn: z
        .number()
        .int()
        .describe("Return actions with turn >= this value. Use 0 for full history."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgBridge.call("diff_since", {
          project_id: args.project_id,
          since_turn: args.since_turn,
        });
        return kgResult(result);
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
