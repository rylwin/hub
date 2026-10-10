import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { handleProviderRequest } from "./server/runtime.js";

vi.mock("./server/runtime.js", () => ({
  handleProviderRequest: vi.fn(() => Promise.resolve(Response.json({ accepted: true }))),
}));
import { Route } from "./routes/api/integrations/shortcut/events.js";

interface ShortcutRouteHandlers {
  POST(input: { request: Request }): Promise<Response>;
  GET(): Response;
  DELETE(): Response;
  PUT(): Response;
  PATCH(): Response;
  HEAD(): Response;
  OPTIONS(): Response;
}

it("passes an intact POST request to the native Shortcut webhook receiver", async () => {
  const request = new Request("https://hub.test/api/integrations/shortcut/events", {
    method: "POST",
    headers: { "Payload-Signature": "signature" },
    body: "original body",
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated TanStack route handler union cannot express direct handler calls
  const handlers = Route.options.server?.handlers as unknown as ShortcutRouteHandlers;
  const response = await handlers.POST({ request });
  assert.deepEqual(vi.mocked(handleProviderRequest).mock.calls.at(-1), [
    "shortcut.events",
    request,
  ]);
  assert.equal(response.status, 200);
});

it.each(["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"] as const)(
  "keeps the Shortcut webhook endpoint POST-only for %s",
  (method) => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated TanStack route handler union cannot express direct handler calls
    const handlers = Route.options.server?.handlers as unknown as ShortcutRouteHandlers;
    const response = handlers[method]();
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  },
);
