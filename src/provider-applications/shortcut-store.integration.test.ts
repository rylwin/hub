import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createProviderApplicationStore, createProviderApplicationInventory } from "./index.js";

it("persists and restores Shortcut's verified workspace/member identity in PGlite", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-shortcut-configuration-"));
  let bundle = await embeddedDatabaseRuntime(root);
  try {
    await bundle.runtime.migrate();
    await bundle.runtime.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at, must_change_password, is_instance_operator) values ('operator', 'Operator', 'shortcut@example.test', true, now(), now(), false, true)`,
    );
    const store = createProviderApplicationStore(bundle.runtime, bundle.locks);
    const configuration = {
      provider: "shortcut" as const,
      apiToken: "shortcut-private-test-token",
      webhookSecret: "shortcut-private-test-secret",
    };
    const identity = {
      provider: "shortcut" as const,
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    };
    await store.save({
      provider: "shortcut",
      configuration,
      identity,
      expectedVersion: undefined,
      updatedByUserId: "operator",
    });
    await bundle.runtime.query(
      `insert into organization (id, name, slug) values ('shortcut-org', 'Shortcut', 'shortcut')`,
    );
    await bundle.runtime.query(
      `insert into shortcut_connections (organization_id, workspace_id, provider_application_id, slug, workspace_name, bot_member_id, api_token) values ('shortcut-org', $1, $1, 'shortcut', 'Example', $2, 'shortcut-private-test-token')`,
      [identity.id, identity.memberId],
    );
    const connections = await createProviderApplicationInventory(
      bundle.runtime,
    ).connectedIdentities("shortcut");
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.name, "Example");
    assert.equal(connections[0]?.applicationId, identity.id);
    assert.equal(
      await createProviderApplicationInventory(bundle.runtime).claimLegacyConnections(
        "shortcut",
        identity,
      ),
      true,
    );
    assert.equal(JSON.stringify(connections).includes("shortcut-private-test-token"), false);
    await assert.rejects(
      store.save({
        provider: "shortcut",
        configuration,
        identity: { ...identity, id: "00000000-0000-4000-8000-000000000009" },
        expectedVersion: 1,
        updatedByUserId: "operator",
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "ProviderApplicationIdentityConflictError",
    );
    await bundle.runtime.close();
    bundle = await embeddedDatabaseRuntime(root);
    await bundle.runtime.migrate();
    const stored = await createProviderApplicationStore(bundle.runtime, bundle.locks).read(
      "shortcut",
    );
    assert.deepEqual(stored?.configuration, configuration);
    assert.deepEqual(stored?.identity, identity);
    assert.equal(stored?.version, 1);
  } finally {
    await bundle.runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
