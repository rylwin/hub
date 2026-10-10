import { createFileRoute } from "@tanstack/react-router";
import { handleProviderRequest } from "../../../../server/runtime.js";

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const Route = createFileRoute("/api/integrations/shortcut/events")({
  server: {
    handlers: {
      POST: ({ request }) => handleProviderRequest("shortcut.events", request),
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
      PUT: methodNotAllowed,
      PATCH: methodNotAllowed,
      HEAD: methodNotAllowed,
      OPTIONS: methodNotAllowed,
    },
  },
});
