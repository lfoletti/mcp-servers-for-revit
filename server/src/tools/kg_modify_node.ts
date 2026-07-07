import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Modify a user-defined node's attrs. Forwards to the `kg_modify_node` command. */
export function registerKgModifyNodeTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_modify_node",
    "Modify attrs of a user-defined node (free-form). Refuses Revit-projected nodes — edit those in Revit, not the KG.",
    {
      llm_id: z.string().describe("llm_id of the user-defined node to modify."),
      updates: z
        .record(z.any())
        .describe("Attribute keys/values to set (merged into the node's attrs)."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_modify_node", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
