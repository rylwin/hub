import assert from "node:assert/strict";
import { it } from "vitest";
import { parseProviderApplicationConfiguration } from "./internal/store.js";
import { createProviderApplicationVerifier } from "./internal/verifier.js";
import { ProviderVerificationError, readProviderApplicationEnvironment } from "./index.js";

it("verifies the configured Shortcut account and records its workspace and member identity", async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const memberId = "00000000-0000-4000-8000-000000000002";
  const verifier = createProviderApplicationVerifier({
    fetch: (input, init) => {
      assert.equal(input, "https://api.app.shortcut.com/api/v3/member");
      assert.equal(new Headers(init?.headers).get("Shortcut-Token"), "shortcut-test-token");
      assert.equal(init?.redirect, "error");
      return Promise.resolve(
        Response.json({
          id: memberId,
          name: "Bot",
          workspace2: { id: workspaceId, name: "Example" },
        }),
      );
    },
  });

  assert.deepEqual(
    await verifier.verify("shortcut", {
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-webhook-secret",
    }),
    { provider: "shortcut", id: workspaceId, name: "Example", memberId },
  );
});

it.each([
  [401, "credentialsRejected"],
  [403, "credentialsRejected"],
  [429, "rateLimited"],
  [503, "upstreamUnavailable"],
] as const)("rejects HTTP %s during Shortcut verification as %s", async (status, reason) => {
  const verifier = createProviderApplicationVerifier({
    fetch: () =>
      Promise.resolve(
        Response.json(
          {
            id: "00000000-0000-4000-8000-000000000002",
            workspace2: { id: "00000000-0000-4000-8000-000000000001", name: "Example" },
          },
          { status },
        ),
      ),
  });

  await assert.rejects(
    verifier.verify("shortcut", {
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-webhook-secret",
    }),
    (error: unknown) => error instanceof ProviderVerificationError && error.reason === reason,
  );
});

it("reports invalid Shortcut member responses without echoing credentials or response bodies", async () => {
  const verifier = createProviderApplicationVerifier({
    fetch: () => Promise.resolve(Response.json({ detail: "shortcut-test-token" })),
  });
  await assert.rejects(
    verifier.verify("shortcut", {
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-webhook-secret",
    }),
    (error: unknown) =>
      error instanceof ProviderVerificationError &&
      error.reason === "invalidResponse" &&
      !error.message.includes("shortcut-test-token"),
  );
});

it("reads Shortcut's token and signing secret from private environment configuration", async () => {
  const result = await readProviderApplicationEnvironment({
    SHORTCUT_API_TOKEN: "shortcut-test-token",
    SHORTCUT_WEBHOOK_SECRET: "shortcut-test-secret",
  });
  assert.deepEqual(result.shortcut, {
    provider: "shortcut",
    apiToken: "shortcut-test-token",
    webhookSecret: "shortcut-test-secret",
  });
});

it.each([
  { SHORTCUT_API_TOKEN: "shortcut-test-token" },
  { SHORTCUT_WEBHOOK_SECRET: "shortcut-test-secret" },
])("fails startup on incomplete Shortcut environment configuration", async (environment) => {
  await assert.rejects(
    readProviderApplicationEnvironment(environment),
    /Shortcut environment configuration requires SHORTCUT_API_TOKEN and SHORTCUT_WEBHOOK_SECRET/u,
  );
});

it("accepts Shortcut's API-token and webhook-secret application configuration", () => {
  assert.deepEqual(
    parseProviderApplicationConfiguration({
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-webhook-secret",
    }),
    {
      provider: "shortcut",
      apiToken: "shortcut-test-token",
      webhookSecret: "shortcut-test-webhook-secret",
    },
  );
});
