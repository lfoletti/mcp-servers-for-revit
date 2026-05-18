import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Expose the KG's typed schema so the agent can form schema-valid elements
 * up front instead of guessing attr names and thrashing on validation
 * errors (the strict typed store rejects unknown/missing attrs, and a
 * bad item rolls back the whole atomic batch). The service already had
 * this (`schema` method, ex-sidecar `m_schema`) — it was never surfaced
 * as a tool. Call this BEFORE kg_add_element / kg_modify_element.
 */
export function registerKgSchemaTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_schema",
    "Return the Knowledge Graph typed schema: for each node type its required/optional attribute names (+ session_only flag), and the allowed edge types. Call this FIRST, before kg_add_element/kg_modify_element, so you pass exactly the required attrs (the store rejects unknown/missing attrs and a bad item rolls back the whole atomic batch). Pass node_type to get just one type (token-cheap).",
    {
      node_type: z
        .string()
        .optional()
        .describe(
          "Optional: return only this node type's spec (e.g. 'Wall'). Omit for the full schema."
        ),
    },
    async (args: any) => {
      try {
        const full = await kgService.call("schema", {});
        if (args?.node_type) {
          const spec = full?.node_types?.[args.node_type];
          if (!spec) {
            return kgResult({
              success: false,
              error: `Unknown node type: ${args.node_type}`,
              known_node_types: Object.keys(full?.node_types ?? {}),
            });
          }
          return kgResult({
            success: true,
            node_type: args.node_type,
            ...spec,
            edge_types: full.edge_types,
          });
        }
        return kgResult({ success: true, ...full });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
