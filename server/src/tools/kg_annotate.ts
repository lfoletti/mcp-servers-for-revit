import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** Author/replace/delete a semantic edge. Forwards to the `kg_annotate` command. */
export function registerKgAnnotateTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_annotate",
    "Author/replace/delete a semantic (KG-owned) edge. Built-in kinds: replaced_by | tagged | violates_rule | implements_intent | contains. Any other name = a USER-DEFINED edge type, registered on first use; Revit-owned types (at_level, is_type, hosts, bounded_by, connects_at, derived_from) are rejected. 'contains' groups nodes under a user-defined node. payload object = upsert/replace; payload null/absent = delete if present. Edges survive re-projection and undo/redo.",
    {
      src: z.string().describe("Source node llm_id (may be soft-deleted)."),
      dst: z.string().describe("Destination node llm_id (may be soft-deleted)."),
      kind: z.string().describe("Edge kind (built-in or user-defined; not a Revit-owned type)."),
      payload: z
        .record(z.any())
        .nullable()
        .optional()
        .describe("Edge attributes to upsert/replace. Pass null or omit to delete the edge."),
    },
    async (args: any) => {
      try {
        return kgResult(await kgSend("kg_annotate", args));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
