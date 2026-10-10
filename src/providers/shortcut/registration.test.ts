import assert from "node:assert/strict";
import { it } from "vitest";
import { z } from "zod";
import { createMemoryDatabase } from "../../db/memory.js";
import { createShortcutRegistration } from "./index.js";
import type { AuthServer } from "../../auth/server.js";
import type { BindShortcutConnectionInput, StartConnectionAttemptInput } from "../../db/types.js";

it("requests a scoped configured-workspace binding and returns to Hub without OAuth", async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const memberId = "00000000-0000-4000-8000-000000000002";
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user",
        organizationId: "org",
        organizationName: "Org",
        organizationSlug: "org",
        membershipId: "membership",
        role: "owner",
      },
    ],
  });
  let attempt: StartConnectionAttemptInput | undefined;
  let binding: BindShortcutConnectionInput | undefined;
  database.startConnectionAttempt = (input) => {
    attempt = input;
    return Promise.resolve();
  };
  database.bindShortcutConnection = (input) => {
    binding = input;
    return Promise.resolve();
  };
  const registration = createShortcutRegistration({
    database,
    auth: {
      ...unusedAuth(),
      resolveAccount: () =>
        Promise.resolve({
          session: { id: "session", activeOrganizationId: null },
          account: { id: "user", name: "User", email: "user@example.test" },
          isInstanceOperator: false,
        }),
    },
    applicationBaseUrl: "https://hub.test",
    configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
    identity: { provider: "shortcut", id: workspaceId, name: "Example", memberId },
    fetch: () =>
      Promise.resolve(
        Response.json({
          id: memberId,
          name: "Bot",
          workspace2: { id: workspaceId, name: "Example" },
        }),
      ),
  });
  const response = await registration.connection.actions["start"]!(
    new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
  );
  assert.equal(response.status, 200);
  assert.equal(attempt?.provider, "shortcut");
  assert.equal(attempt?.access.organizationId, "org");
  assert.equal(binding?.stateVerifier, attempt?.stateVerifier);
  assert.equal(binding?.phase, "shortcut_verification");
  assert.equal(binding?.botMemberId, memberId);
  assert.equal(binding?.apiToken, "shortcut-test-token");
  assert.equal(binding?.providerApplicationId, workspaceId);
  const body = z.object({ url: z.string().url() }).parse(await response.json());
  const target = new URL(body.url);
  assert.equal(target.origin, "https://hub.test");
  assert.equal(target.pathname, "/o/org/connections");
  assert.equal(target.searchParams.get("result"), "shortcut_connected");
});

it.each(["workspace", "member"])(
  "fails closed when the configured token's %s identity changed before binding",
  async (changed) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const memberId = "00000000-0000-4000-8000-000000000002";
    const differentId = "00000000-0000-4000-8000-000000000003";
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user",
          organizationId: "org",
          organizationName: "Org",
          organizationSlug: "org",
          membershipId: "membership",
          role: "owner",
        },
      ],
    });
    database.startConnectionAttempt = () => Promise.resolve();
    let bindings = 0;
    database.bindShortcutConnection = () => {
      bindings++;
      return Promise.resolve();
    };
    const registration = createShortcutRegistration({
      database,
      auth: {
        ...unusedAuth(),
        resolveAccount: () =>
          Promise.resolve({
            session: { id: "session", activeOrganizationId: null },
            account: { id: "user", name: "User", email: "user@example.test" },
            isInstanceOperator: false,
          }),
      },
      applicationBaseUrl: "https://hub.test",
      configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
      identity: { provider: "shortcut", id: workspaceId, name: "Example", memberId },
      fetch: () =>
        Promise.resolve(
          Response.json({
            id: changed === "member" ? differentId : memberId,
            name: "Bot",
            workspace2: {
              id: changed === "workspace" ? differentId : workspaceId,
              name: "Example",
            },
          }),
        ),
    });
    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 409);
    assert.equal(bindings, 0);
  },
);

it.each(["GET", "DELETE"])(
  "only accepts POST for native Shortcut binding, rejecting %s before authority access",
  async (method) => {
    const registration = createShortcutRegistration({
      database: createMemoryDatabase(),
      auth: unusedAuth(),
      applicationBaseUrl: "https://hub.test",
      configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
      identity: {
        provider: "shortcut",
        id: "00000000-0000-4000-8000-000000000001",
        name: "Example",
        memberId: "00000000-0000-4000-8000-000000000002",
      },
    });
    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method }),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  },
);

it("rejects a cross-origin Shortcut connection mutation before reading credentials or authority", async () => {
  const registration = createShortcutRegistration({
    database: createMemoryDatabase(),
    auth: {
      ...unusedAuth(),
      rejectCookieMutation: () => Response.json({ error: "forbidden" }, { status: 403 }),
    },
    applicationBaseUrl: "https://hub.test",
    configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
    identity: {
      provider: "shortcut",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    },
    fetch: () => Promise.reject(new Error("must not read provider credentials")),
  });
  const response = await registration.connection.actions["start"]!(
    new Request("https://hub.test/start?organizationSlug=org", {
      method: "POST",
      headers: { Origin: "https://attacker.test" },
    }),
  );
  assert.equal(response.status, 403);
});

it("cannot use a different workspace's saved credentials for a reply", async () => {
  const database = createMemoryDatabase();
  const otherWorkspaceId = "00000000-0000-4000-8000-000000000003";
  database.findShortcutConnection = () =>
    Promise.resolve({
      id: "connection",
      organizationId: "org",
      slug: "other",
      providerApplicationId: otherWorkspaceId,
      workspaceId: otherWorkspaceId,
      workspaceName: "Other",
      botMemberId: "bot",
      apiToken: "other-token",
    });
  let requests = 0;
  const registration = createShortcutRegistration({
    database,
    auth: null,
    applicationBaseUrl: "https://hub.test",
    configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
    identity: {
      provider: "shortcut",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    },
    fetch: () => {
      requests++;
      return Promise.resolve(Response.json({}));
    },
  });
  await assert.rejects(
    registration.outputs[0]!.execute({
      agentExecutionId: "execution",
      toolType: "shortcut.reply",
      args: { content: "Hello" },
      outputContext: {
        provider: "shortcut",
        workspaceId: otherWorkspaceId,
        storyId: 123,
        parentId: 456,
      },
    }),
    /Shortcut connection unavailable/u,
  );
  assert.equal(requests, 0);
});

it.each(["member", "token"])(
  "requires reconnecting a stale Shortcut %s binding before replies",
  async (changed) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const memberId = "00000000-0000-4000-8000-000000000002";
    const database = createMemoryDatabase({
      shortcutConnections: [
        {
          id: "connection",
          organizationId: "org",
          slug: "example-shortcut",
          providerApplicationId: workspaceId,
          workspaceId,
          workspaceName: "Example",
          botMemberId: changed === "member" ? "old-bot" : memberId,
          apiToken: changed === "token" ? "old-token" : "shortcut-test-token",
        },
      ],
    });
    let requests = 0;
    const registration = createShortcutRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
      identity: { provider: "shortcut", id: workspaceId, name: "Example", memberId },
      fetch: () => {
        requests++;
        return Promise.resolve(Response.json({}));
      },
    });
    await assert.rejects(
      registration.outputs[0]!.execute({
        agentExecutionId: "execution",
        toolType: "shortcut.reply",
        args: { content: "Hello" },
        outputContext: { provider: "shortcut", workspaceId, storyId: 123, parentId: 456 },
      }),
      /Shortcut connection unavailable/u,
    );
    assert.equal(requests, 0);
    assert.deepEqual(
      registration.connection.status(await database.organizationConnectionUsage("org")),
      { status: "requiresReauthorization" },
    );
  },
);

it("disconnects through organization-scoped database authority without revoking the bot token", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000003";
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user",
        organizationId: "org",
        organizationName: "Org",
        organizationSlug: "org",
        membershipId: "membership",
        role: "owner",
      },
    ],
  });
  let disconnected: unknown;
  database.disconnectConnection = (provider, id, access) => {
    disconnected = { provider, id, access };
    return Promise.resolve({ provider: "shortcut" });
  };
  const registration = createShortcutRegistration({
    database,
    auth: {
      ...unusedAuth(),
      resolveAccount: () =>
        Promise.resolve({
          session: { id: "session", activeOrganizationId: null },
          account: { id: "user", name: "User", email: "user@example.test" },
          isInstanceOperator: false,
        }),
    },
    applicationBaseUrl: "https://hub.test",
    configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
    identity: {
      provider: "shortcut",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    },
    fetch: () => Promise.reject(new Error("must not revoke shared token")),
  });
  const response = await registration.connection.actions["disconnect"]!(
    new Request(`https://hub.test/disconnect?organizationSlug=org&connectionId=${connectionId}`, {
      method: "POST",
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { disconnected: true });
  assert.deepEqual(disconnected, {
    provider: "shortcut",
    id: connectionId,
    access: {
      sessionId: "session",
      userId: "user",
      membershipId: "membership",
      organizationId: "org",
      returnRoute: "/o/org/connections",
    },
  });
});

it("registers native Shortcut mention intake and a bound threaded reply capability", () => {
  const registration = createShortcutRegistration({
    database: createMemoryDatabase(),
    auth: null,
    applicationBaseUrl: "https://hub.test",
    configurationVersion: 1,
    configuration: { apiToken: "shortcut-test-token", webhookSecret: "shortcut-test-secret" },
    identity: {
      provider: "shortcut",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example",
      memberId: "00000000-0000-4000-8000-000000000002",
    },
  });
  assert.equal(registration.connection.name, "shortcut");
  assert.equal(registration.sources.length, 1);
  assert.equal(registration.triggerProviders.length, 1);
  assert.deepEqual(
    registration.outputs.map((output) => output.type),
    ["shortcut.reply"],
  );
  assert.deepEqual(
    registration.requests.map((request) => request.name),
    ["shortcut.events"],
  );
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
