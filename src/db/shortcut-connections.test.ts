import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { createDatabase } from "./pg.js";
import { createMemoryDatabase } from "./memory.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import type { DatabaseRuntime } from "./runtime/index.js";
import type { BindShortcutConnectionInput, Database, ShortcutConnectionRecord } from "./types.js";

const FIXTURE: ShortcutConnectionRecord = {
  id: "connection",
  organizationId: "org",
  slug: "acme-shortcut",
  providerApplicationId: "shortcut-app",
  workspaceId: "workspace",
  workspaceName: "Acme",
  botMemberId: "bot",
  apiToken: "token",
};

it("reads organization-scoped Shortcut fixtures in the memory test double", async () => {
  const database = createMemoryDatabase({ shortcutConnections: [FIXTURE] });
  assert.deepEqual(await database.findShortcutConnection("workspace"), FIXTURE);
  assert.deepEqual(
    await database.findShortcutConnectionForOrganization("org", "workspace"),
    FIXTURE,
  );
  assert.equal(
    await database.findShortcutConnectionForOrganization("other", "workspace"),
    undefined,
  );
  assert.deepEqual((await database.organizationConnectionUsage("org")).shortcut, [FIXTURE]);
  assert.deepEqual((await database.organizationConnectionUsage("other")).shortcut, []);
});

it("keeps connection writes unavailable in the unauthenticated memory test double", () => {
  const database = createMemoryDatabase();
  assert.throws(
    () =>
      database.bindShortcutConnection({
        stateVerifier: "attempt",
        phase: "shortcut_verification",
        access: { sessionId: "session", userId: "user" },
        providerApplicationId: "shortcut-app",
        workspaceId: "workspace",
        workspaceName: "Acme",
        botMemberId: "bot",
        apiToken: "token",
      }),
    /connection persistence requires PostgreSQL/,
  );
});

it("accepts routed Shortcut events without putting the API token in the event", async () => {
  const database = createMemoryDatabase({ shortcutConnections: [FIXTURE] });
  const project = await database.createProject({
    organizationId: "org",
    name: "Project",
    slug: "project",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: {},
    contentHash: "config",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, [
    { provider: "shortcut", connectionId: FIXTURE.id, resourceId: null, triggerName: "mention" },
  ]);
  const input = {
    workspaceId: "workspace",
    deliveryId: "delivery",
    source: "shortcut.comment",
    payload: { comment: "@bot hello" },
    receivedAt: new Date(),
  };
  const result = await database.acceptShortcutEvent(input);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("Shortcut event was not accepted");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.connectionId, FIXTURE.id);
  assert.equal(result.events[0]?.resourceId, null);
  assert.deepEqual(result.events[0]?.payload, input.payload);
  const receipt = await database.findProviderEventReceiptById(result.receiptId);
  assert.equal(receipt?.provider, "shortcut");
  assert.deepEqual(await database.acceptShortcutEvent(input), result);
  const dropped = await database.acceptShortcutEvent({
    ...input,
    workspaceId: "unbound",
    deliveryId: "unbound",
  });
  assert.equal(dropped.status, "dropped");
  if (dropped.status === "dropped") assert.equal(dropped.reason, "shortcut_unbound");
});

const ACCESS = {
  sessionId: "session",
  userId: "operator",
  membershipId: "member",
  organizationId: "org",
  returnRoute: "/",
};

describe("Shortcut connection persistence", () => {
  let root: string;
  let runtime: DatabaseRuntime;
  let database: Database;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-shortcut-"));
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    runtime = bundle.runtime;
    database = createDatabase(runtime, bundle.locks);
    await runtime.migrate();
    await runtime.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                           must_change_password, is_instance_operator)
       values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
    );
    await runtime.query(`insert into organization (id, name, slug) values ('org', 'Org', 'org')`);
    await runtime.query(
      `insert into session (id, token, user_id, active_organization_id, expires_at)
       values ('session', 'token', 'operator', 'org', now() + interval '1 hour')`,
    );
    await runtime.query(
      `insert into member (id, organization_id, user_id, role)
       values ('member', 'org', 'operator', 'owner')`,
    );
    await runtime.query(
      `insert into organization (id, name, slug) values ('other', 'Other', 'other')`,
    );
    await runtime.query(
      `insert into member (id, organization_id, user_id, role) values ('other-member', 'other', 'operator', 'admin')`,
    );
    await runtime.query(
      `insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
       values ('shortcut', 'shortcut-app', 0)`,
    );
  }, 30_000);

  beforeEach(async () => {
    await runtime.query(`delete from shortcut_connections`);
    await runtime.query(`delete from organization_connection_attempts`);
  });

  afterAll(async () => {
    await runtime?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("binds a verified workspace through a durable attempt", async () => {
    await seedBinding();
    const connection = await database.findShortcutConnection("workspace");
    assert.ok(connection);
    assert.deepEqual(connection, {
      id: connection.id,
      organizationId: "org",
      slug: "acme-shortcut",
      providerApplicationId: "shortcut-app",
      workspaceId: "workspace",
      workspaceName: "Acme",
      botMemberId: "bot-member",
      apiToken: "api-token",
    });
  });

  it("reconnects without changing ID or slug and consumes the attempt", async () => {
    await seedBinding();
    const original = await database.findShortcutConnection("workspace");
    assert.ok(original);
    await startAttempt("reconnect");
    await bind("reconnect", {
      workspaceName: "Renamed",
      botMemberId: "new-member",
      apiToken: "rotated-token",
    });
    const rebound = await database.findShortcutConnection("workspace");
    assert.deepEqual(rebound, {
      ...original,
      workspaceName: "Renamed",
      botMemberId: "new-member",
      apiToken: "rotated-token",
    });
    await assert.rejects(bind("reconnect"), { name: "ConnectionAttemptUnavailableError" });
    assert.deepEqual(await database.findShortcutConnection("workspace"), rebound);
  });

  it("does not move a workspace between organizations", async () => {
    await seedBinding();
    const original = await database.findShortcutConnection("workspace");
    await startAttempt("other-org", {
      ...ACCESS,
      membershipId: "other-member",
      organizationId: "other",
    });
    await assert.rejects(bind("other-org", { apiToken: "foreign-token" }), {
      name: "ConnectionConflictError",
    });
    assert.deepEqual(await database.findShortcutConnection("workspace"), original);
  });

  it("scopes connection lookup and usage to the organization", async () => {
    await seedBinding();
    const connection = await database.findShortcutConnection("workspace");
    assert.ok(connection);
    assert.deepEqual(
      await database.findShortcutConnectionForOrganization("org", "workspace"),
      connection,
    );
    assert.equal(
      await database.findShortcutConnectionForOrganization("other", "workspace"),
      undefined,
    );
    assert.equal(await database.findShortcutConnection("missing"), undefined);
    assert.deepEqual((await database.organizationConnectionUsage("org")).shortcut, [connection]);
    assert.deepEqual((await database.organizationConnectionUsage("other")).shortcut, []);
  });

  it("disconnects only with management authority for the binding's organization", async () => {
    await seedBinding();
    const connection = await database.findShortcutConnection("workspace");
    assert.ok(connection);
    await assert.rejects(
      database.disconnectConnection("shortcut", connection.id, {
        ...ACCESS,
        membershipId: "other-member",
        organizationId: "other",
      }),
      { name: "ConnectionAccessDeniedError" },
    );
    assert.deepEqual(await database.findShortcutConnection("workspace"), connection);
    assert.deepEqual(await database.disconnectConnection("shortcut", connection.id, ACCESS), {
      provider: "shortcut",
    });
    assert.equal(await database.findShortcutConnection("workspace"), undefined);
    assert.deepEqual((await database.organizationConnectionUsage("org")).shortcut, []);
  });

  it("rejects authority revoked while external verification was in flight", async () => {
    await startAttempt("revoked-membership");
    await runtime.query(`update member set role = 'member' where id = 'member'`);
    try {
      await assert.rejects(bind("revoked-membership"), { name: "ConnectionAccessDeniedError" });
      assert.equal(await database.findShortcutConnection("workspace"), undefined);
    } finally {
      await runtime.query(`update member set role = 'owner' where id = 'member'`);
    }
    await bind("revoked-membership");
    const connection = await database.findShortcutConnection("workspace");
    assert.ok(connection);
    await database.disconnectConnection("shortcut", connection.id, ACCESS);
  });

  it("rejects a revoked account session", async () => {
    await startAttempt("revoked-session");
    await runtime.query(
      `update session set expires_at = now() - interval '1 minute' where id = 'session'`,
    );
    try {
      await assert.rejects(bind("revoked-session"), { name: "ConnectionAccessDeniedError" });
      assert.equal(await database.findShortcutConnection("workspace"), undefined);
    } finally {
      await runtime.query(
        `update session set expires_at = now() + interval '1 hour' where id = 'session'`,
      );
    }
  });

  it("rejects expired attempts and mismatched account or phase", async () => {
    await startAttempt("expired");
    await runtime.query(
      `update organization_connection_attempts set expires_at = now() - interval '1 minute' where state_verifier = 'expired'`,
    );
    await assert.rejects(bind("expired"), { name: "ConnectionAttemptUnavailableError" });
    await startAttempt("mismatched");
    await assert.rejects(
      bind("mismatched", { access: { userId: "somebody-else", sessionId: "session" } }),
      { name: "ConnectionAccessDeniedError" },
    );
    await assert.rejects(bind("mismatched", { phase: "linear_authorization" }), {
      name: "ConnectionAttemptUnavailableError",
    });
    assert.equal(await database.findShortcutConnection("workspace"), undefined);
  });

  it("rejects provider configuration or application changes during verification", async () => {
    await startAttempt("changed-config");
    await runtime.query(
      `update runtime_provider_activation set configuration_version = 1 where provider = 'shortcut'`,
    );
    try {
      await assert.rejects(bind("changed-config"), { name: "ProviderApplicationChangedError" });
      assert.equal(await database.findShortcutConnection("workspace"), undefined);
    } finally {
      await runtime.query(
        `update runtime_provider_activation set configuration_version = 0 where provider = 'shortcut'`,
      );
    }
    await assert.rejects(bind("changed-config", { providerApplicationId: "other-app" }), {
      name: "ProviderApplicationChangedError",
    });
    await runtime.query(
      `update runtime_provider_activation set provider_application_id = 'other-app' where provider = 'shortcut'`,
    );
    try {
      await assert.rejects(bind("changed-config"), { name: "ProviderApplicationChangedError" });
      assert.equal(await database.findShortcutConnection("workspace"), undefined);
    } finally {
      await runtime.query(
        `update runtime_provider_activation set provider_application_id = 'shortcut-app' where provider = 'shortcut'`,
      );
    }
  });

  it("does not allow a different provider's attempt to authorize a Shortcut binding", async () => {
    await runtime.query(
      `insert into runtime_provider_activation (provider, provider_application_id, configuration_version) values ('linear', 'shortcut-app', 0)`,
    );
    await database.startConnectionAttempt({
      provider: "linear",
      stateVerifier: "wrong-provider",
      access: ACCESS,
      lifetimeMinutes: 10,
      configurationVersion: 0,
      providerApplicationId: "shortcut-app",
      callbackOrigin: "https://hub.example.test",
      configurationSnapshot: {},
      expectedConfigurationVersion: null,
      activateConfiguration: false,
    });
    await assert.rejects(bind("wrong-provider", { phase: "linear_authorization" }), {
      name: "ConnectionAttemptUnavailableError",
    });
    assert.equal(await database.findShortcutConnection("workspace"), undefined);
  });

  it("allocates distinct slugs when workspace names collide", async () => {
    await startAttempt("same-name-first");
    await bind("same-name-first", { workspaceId: "same-name-first" });
    await startAttempt("same-name-second");
    await bind("same-name-second", { workspaceId: "same-name-second" });
    assert.equal((await database.findShortcutConnection("same-name-first"))?.slug, "acme-shortcut");
    assert.equal(
      (await database.findShortcutConnection("same-name-second"))?.slug,
      "acme-shortcut-2",
    );
  });

  async function seedBinding() {
    await startAttempt("initial");
    await bind("initial");
  }

  function startAttempt(stateVerifier: string, access = ACCESS) {
    return database.startConnectionAttempt({
      provider: "shortcut",
      stateVerifier,
      access,
      lifetimeMinutes: 10,
      configurationVersion: 0,
      providerApplicationId: "shortcut-app",
      callbackOrigin: "https://hub.example.test",
      configurationSnapshot: { provider: "shortcut" },
      expectedConfigurationVersion: null,
      activateConfiguration: false,
    });
  }

  function bind(stateVerifier: string, overrides: Partial<BindShortcutConnectionInput> = {}) {
    return database.bindShortcutConnection({
      stateVerifier,
      phase: "shortcut_verification",
      access: { sessionId: ACCESS.sessionId, userId: ACCESS.userId },
      providerApplicationId: "shortcut-app",
      workspaceId: "workspace",
      workspaceName: "Acme",
      botMemberId: "bot-member",
      apiToken: "api-token",
      ...overrides,
    });
  }
});
