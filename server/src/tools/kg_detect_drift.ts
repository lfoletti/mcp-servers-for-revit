import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Detect KG-vs-Revit divergence. Forwards to the `kg_detect_drift` command. */
export function registerKgDetectDriftTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_detect_drift",
    "Compare the KG v2 projection against the active Revit document and return divergences (missing_in_kg, orphan_kg_node, tombstoned_but_live, attrs_diverged). Read-only. Optional node_type filter.",
    {
      node_type: z
        .string()
        .optional()
        .describe("Restrict drift detection to one node type."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_detect_drift", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
