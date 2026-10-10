import assert from "node:assert/strict";
import { it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { DynamicProviderRuntime } from "./runtime-owner.js";
import type { AuthServer } from "../../auth/server.js";

it("activates the native Shortcut slice through the production runtime factory", async () => {
  const runtime = new DynamicProviderRuntime({
    database: createMemoryDatabase(),
    auth: unusedAuth(),
    applicationBaseUrl: "https://hub.test",
  });
  const candidate = await runtime.prepare(
    "shortcut",
    {
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-secret",
    },
    "https://hub.test",
    {
      provider: "shortcut",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    },
    1,
  );
  await candidate.start();
  candidate.publish();
  const registration = runtime
    .registrations()
    .find((entry) => entry.connection.name === "shortcut")!;
  assert.ok(registration);
  const triggers = registration.triggerProviders[0]!({
    configurationStoreForProject: () => {
      throw new Error("unused");
    },
    connectionsForProject: () => {
      throw new Error("unused");
    },
  });
  assert.deepEqual(triggers?.eventNames, ["shortcut.comment"]);
  const endpoint = registration.requests.find((entry) => entry.name === "shortcut.events")!;
  assert.ok(endpoint);
  const response = await endpoint.handle(
    new Request("https://hub.test/api/integrations/shortcut/events"),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  await registration.sources[0]!.stop();
});

function unusedAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("unused")),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () => Promise.reject(new Error("unused")),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
