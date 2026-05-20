import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callV2, mcpResult, mcpError } from "../kg-v2/client.js";
import { kgV2ToolsEnabled, logKgV2ModeOnce } from "../kg-v2/mode.js";

const KindSchema = z.enum([
  "replaced_by",
  "tagged",
  "violates_rule",
  "implements_intent",
]);

export function registerKgV2AnnotateTool(server: McpServer) {
  logKgV2ModeOnce();
  if (!kgV2ToolsEnabled()) return;
  server.tool(
    "kg_v2_annotate",
    "Author / replace / delete an F2 semantic annotation edge between two KG nodes. Supported kinds: replaced_by (audit trail for Rebind), tagged (free-form labels), violates_rule (KB compliance pointer), implements_intent (design intent registry pointer). The KB / intent-registry validators are out of scope for v2.0 — payload is free-form. Pass a payload object to upsert/replace ; omit payload or pass null to delete the edge if it exists (idempotent, no-op otherwise). Annotations accept soft-deleted src/dst and survive undo/redo by design (§6).",
    {
      kind: KindSchema.describe("Annotation kind (replaced_by | tagged | violates_rule | implements_intent)."),
      src: z.string().describe("Source llm_id (may be soft-deleted)."),
      dst: z.string().describe("Destination llm_id (may be soft-deleted)."),
      payload: z
        .record(z.unknown())
        .nullable()
        .optional()
        .describe("Free-form annotation payload object ; null/omitted = delete the edge if present."),
    },
    async (args: any) => {
      try {
        const params: Record<string, unknown> = {
          kind: args.kind,
          src: args.src,
          dst: args.dst,
        };
        if (args.payload !== undefined) params.payload = args.payload;
        const r = await callV2<unknown>("kg_annotate", params);
        return mcpResult(r);
      } catch (e) {
        return mcpError(e);
      }
    }
  );
}
