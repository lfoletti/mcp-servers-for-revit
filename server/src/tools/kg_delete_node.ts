import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Soft-delete a user-defined node. Forwards to the `kg_delete_node` command. */
export function registerKgDeleteNodeTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_delete_node",
    "Soft-delete a user-defined node (history kept). Refuses Revit-projected nodes — delete those in Revit and let the projection tombstone them.",
    {
      llm_id: z.string().describe("llm_id of the user-defined node to soft-delete."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_delete_node", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
