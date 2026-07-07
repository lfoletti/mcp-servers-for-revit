import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Create a user-defined semantic node. Forwards to the `kg_create_node` command. */
export function registerKgCreateNodeTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_create_node",
    "Create a USER-DEFINED semantic node not derived from Revit (e.g. Suite, Zone, Apartment). node_type must not collide with a Revit-projected type. Returns the new llm_id. Link it to existing nodes with kg_annotate kind=contains. Carries no revit_id, so it is invisible to drift detection and untouched by rescan.",
    {
      node_type: z
        .string()
        .describe("The user-defined node type (must not collide with a Revit-projected type)."),
      attrs: z
        .record(z.any())
        .optional()
        .describe("Free-form JSON attributes (no schema)."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_create_node", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
