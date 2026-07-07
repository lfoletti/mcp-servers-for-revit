import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Resolve a Revit ElementId to its KG node. Forwards to `kg_get_by_revit_id`. */
export function registerKgGetByRevitIdTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_get_by_revit_id",
    "Resolve a Revit ElementId to its KG v2 node (or null if unbound). Read-only.",
    {
      revit_id: z
        .number()
        .int()
        .describe("The Revit ElementId (integer) to resolve."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_get_by_revit_id", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
