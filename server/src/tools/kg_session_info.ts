import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kgSend, kgResult, kgError } from "../kg/socket.js";
import { kgToolsEnabled, logKgModeOnce } from "../kg/mode.js";

/** KG v2 session metadata. Forwards to the `kg_session_info` socket command. */
export function registerKgSessionInfoTool(server: McpServer) {
  logKgModeOnce();
  if (!kgToolsEnabled()) return;
  server.tool(
    "kg_session_info",
    "Return KG v2 session metadata: project_id, current turn, node/edge counts, last action summary. Read-only.",
    {},
    async () => {
      try {
        return kgResult(await kgSend("kg_session_info", {}));
      } catch (error) {
        return kgError(error);
      }
    }
  );
}
