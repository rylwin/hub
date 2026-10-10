import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-sessions/$sessionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleSessionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      // Session capabilities also use a stateless, POST-only MCP transport.
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
