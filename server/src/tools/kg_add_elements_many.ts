import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kgService, kgResult, kgError } from "../kg/service.js";
import { kgManyEnabled, logKgModeOnce } from "../kg/mode.js";

/**
 * Bulk create: add N typed nodes (and their typed edges) in ONE atomic
 * transaction and ONE round-trip. If any item is invalid the whole batch
 * rolls back — no partial project state. Use this to seed or to create many
 * elements at once instead of looping kg_add_element. Only registered in
 * `kg-many` mode (single-vs-bulk benchmark isolation).
 */
export function registerKgAddElementsManyTool(server: McpServer) {
  logKgModeOnce();
  if (!kgManyEnabled()) return;
  server.tool(
    "kg_add_elements_many",
    "Atomically add many typed elements (and their relations) to the Knowledge Graph in one call (one transaction, all-or-nothing). Use instead of looping kg_add_element when creating several elements — one round-trip instead of N, and a failed item rolls the whole batch back.",
    {
      items: z
        .array(
          z.object({
            node_type: z.string().describe("KG node type, e.g. Wall, Window."),
            attrs: z
              .record(z.any())
              .optional()
              .describe("Attributes per the node type's schema."),
            llm_id: z.string().optional().describe("Explicit stable id."),
            edges: z
              .array(
                z.object({
                  type: z.string(),
                  to: z.string().optional(),
                  from: z.string().optional(),
                })
              )
              .optional()
              .describe("Typed relations; endpoints must already exist."),
          })
        )
        .describe("Per-element specs. Created atomically in order."),
      project_id: z.string().optional().describe("Project KG id (default 'default')."),
    },
    async (args: any) => {
      try {
        const result = await kgService.call("add_many", {
          project_id: args.project_id,
          items: args.items,
        });
        return kgResult({ success: true, ...result });
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
