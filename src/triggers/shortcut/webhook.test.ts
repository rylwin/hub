import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { DurableProviderEvent } from "../../db/types.js";
import { it } from "vitest";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { createShortcutWebhookSource } from "./webhook.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const webhookId = "00000000-0000-4000-8000-000000000003";
const signingSecret = "shortcut-test-signing-secret";
const payload = JSON.stringify({
  id: webhookId,
  changed_at: "2026-10-10T12:00:00Z",
  member_id: actorId,
  actions: [
    {
      entity_type: "story-comment",
      action: "create",
      id: 456,
      author_id: actorId,
      app_url: "https://app.shortcut.com/example/story/123/test#activity-456",
    },
  ],
});

function acceptedEmpty(): ProviderEventAcceptance {
  return { status: "accepted", receiptId: "receipt-1", events: [] };
}

function signedRequest(body = payload, signature: string | null = sign(body)): Request {
  return new Request("https://hub.test/shortcut/events", {
    method: "POST",
    headers: signature === null ? {} : { "Payload-Signature": signature },
    body,
  });
}

function sign(body: string): string {
  return createHmac("sha256", signingSecret).update(body).digest("hex");
}

it.each([null, "not-a-signature", "0".repeat(64)])(
  "rejects invalid signature evidence %s before intake",
  async (signature) => {
    let calls = 0;
    const source = createShortcutWebhookSource({
      workspaceId,
      signingSecret,
      accept: async () => {
        calls++;
        return acceptedEmpty();
      },
    });
    const response = await source.handle(signedRequest(payload, signature));

    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  },
);

it.each(["GET", "PUT", "DELETE"])("allows only POST, not %s", async (method) => {
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async () => {
      calls++;
      return acceptedEmpty();
    },
  });
  const response = await source.handle(new Request("https://hub.test/shortcut/events", { method }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.equal(calls, 0);
});

it.each([false, true])(
  "persists configuration_unavailable when handlers are absent (stopped=%s)",
  async (stopped) => {
    const database = await createWebhookDatabase();
    const reasons: unknown[] = [];
    let dispatched = 0;
    const source = createShortcutWebhookSource({
      workspaceId,
      signingSecret,
      accept: async (input) => {
        reasons.push(input.dropReason);
        const acceptance = await database.acceptShortcutEvent(input);
        const receipt = await database.findProviderEventReceiptById(acceptance.receiptId);
        assert.equal(receipt?.droppedReason, "configuration_unavailable");
        return acceptance;
      },
    });
    if (stopped) {
      await source.start(async () => {
        dispatched++;
      });
      await source.stop();
    }
    assert.equal((await source.handle(signedRequest())).status, 200);
    assert.equal(dispatched, 0);
    assert.deepEqual(reasons, ["configuration_unavailable"]);
  },
);

async function createWebhookDatabase() {
  const connectionId = "00000000-0000-4000-8000-000000000005";
  const database = createMemoryDatabase({
    shortcutConnections: [
      {
        id: connectionId,
        organizationId: "org",
        slug: "shortcut",
        providerApplicationId: "shortcut-app",
        workspaceId,
        workspaceName: "Example",
        botMemberId: actorId,
        apiToken: "fixture-token",
      },
    ],
  });
  const active = await createActiveProjectConfiguration(
    database,
    {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "mention",
          on: "shortcut.mention",
          max_runtime: "1h",
          filters: { from_users: [actorId] },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "pi" },
              prompt: [{ text: "Work" }],
            },
          ],
        },
      ],
    },
    { organizationId: "org" },
  );
  await database.activateProjectConfigurationRevision(active.project.id, active.revision.id, [
    { provider: "shortcut", connectionId, resourceId: null, triggerName: "mention" },
  ]);
  return database;
}

it("preserves distinct comments in a batch with deterministic per-comment durable evidence", async () => {
  const database = await createWebhookDatabase();
  const body = JSON.stringify({
    id: webhookId,
    member_id: actorId,
    changed_at: "2026-10-10T12:00:00Z",
    actions: [456, 457].map((id) => ({
      entity_type: "story-comment",
      action: "create",
      id,
      app_url: `https://app.shortcut.com/example/story/123/test#activity-${id}`,
    })),
  });
  const dispatched: DurableProviderEvent[] = [];
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: (input) => database.acceptShortcutEvent(input),
  });
  await source.start(async (event) => {
    dispatched.push(event);
  });
  assert.equal((await source.handle(signedRequest(body))).status, 200);
  assert.deepEqual(
    dispatched.map((event) => event.deliveryId),
    [`${webhookId}:456`, `${webhookId}:457`],
  );
  assert.notEqual(dispatched[0]?.providerEventReceiptId, dispatched[1]?.providerEventReceiptId);
  for (const [index, event] of dispatched.entries()) {
    const receipt = await database.findProviderEventReceiptById(event.providerEventReceiptId);
    assert.equal(
      receipt?.signatureHash,
      createHash("sha256")
        .update(body)
        .update(`:${456 + index}`)
        .digest("hex"),
    );
    const repeated = await database.acceptShortcutEvent({
      workspaceId,
      deliveryId: event.deliveryId,
      payload: event.payload,
      source: event.source,
      receivedAt: event.receivedAt,
      signatureHash: receipt?.signatureHash ?? "",
    });
    assert.equal(repeated.receiptId, event.providerEventReceiptId);
  }
});

it("rejects an entire signed batch if a recognized comment creation is malformed", async () => {
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async () => {
      calls++;
      return acceptedEmpty();
    },
  });
  const body = JSON.stringify({
    id: webhookId,
    member_id: actorId,
    changed_at: "2026-10-10T12:00:00Z",
    actions: [
      {
        entity_type: "story-comment",
        action: "create",
        id: 456,
        app_url: "https://app.shortcut.com/example/story/123/test",
      },
      { entity_type: "story-comment", action: "create", id: 457 },
    ],
  });
  assert.equal((await source.handle(signedRequest(body))).status, 400);
  assert.equal(calls, 0);
});

it("ignores unsupported signed story, update, and delete actions without intake", async () => {
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async () => {
      calls++;
      return acceptedEmpty();
    },
  });
  const body = JSON.stringify({
    id: webhookId,
    member_id: actorId,
    changed_at: "2026-10-10T12:00:00Z",
    actions: [
      { entity_type: "story", action: "create" },
      { entity_type: "story-comment", action: "update" },
      { entity_type: "story-comment", action: "delete" },
    ],
  });
  assert.equal((await source.handle(signedRequest(body))).status, 200);
  assert.equal(calls, 0);
});

it("does not dispatch after stop while intake is in flight", async () => {
  const database = await createWebhookDatabase();
  let dispatched = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async (input) => {
      await source.stop();
      return database.acceptShortcutEvent(input);
    },
  });
  await source.start(async () => {
    dispatched++;
  });
  assert.equal((await source.handle(signedRequest())).status, 200);
  assert.equal(dispatched, 0);
});

it("returns 503 if an accepted event handler fails", async () => {
  const database = await createWebhookDatabase();
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: (input) => database.acceptShortcutEvent(input),
  });
  await source.start(async () => {
    throw new Error("dispatch unavailable");
  });
  assert.equal((await source.handle(signedRequest())).status, 503);
});

it("rejects an oversized signed body before durable intake", async () => {
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async () => {
      calls++;
      return acceptedEmpty();
    },
  });
  const response = await source.handle(signedRequest(payload + " ".repeat(1_048_576)));

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

it.each(["{", "{}"])("rejects malformed signed payload %s with 400", async (body) => {
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async () => {
      calls++;
      return acceptedEmpty();
    },
  });
  const response = await source.handle(signedRequest(body));

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

it("dispatches accepted events but not duplicate deliveries", async () => {
  const dispatched: string[] = [];
  let calls = 0;
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async (input) => {
      calls++;
      if (calls > 1) return { status: "duplicate", receiptId: "receipt-1" };
      return {
        status: "accepted",
        receiptId: "receipt-1",
        events: [
          {
            providerEventReceiptId: "receipt-1",
            organizationId: "org-1",
            projectId: "project-1",
            configurationRevisionId: "revision-1",
            source: input.source,
            deliveryId: input.deliveryId,
            payload: input.payload,
            receivedAt: input.receivedAt,
            connectionId: "shortcut-connection",
            resourceId: null,
          },
        ],
      };
    },
  });
  await source.start(async (event) => {
    dispatched.push(event.providerEventReceiptId);
  });
  await source.handle(signedRequest());
  await source.handle(signedRequest());

  assert.deepEqual(dispatched, ["receipt-1"]);
});

it("returns a retryable failure when durable intake is unavailable", async () => {
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: () => Promise.reject(new Error("database unavailable")),
  });
  const response = await source.handle(signedRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "event_handoff_unavailable" });
});

it("accepts a signed comment locator through durable provider intake", async () => {
  const accepted: { workspaceId: string; deliveryId: string; payload: unknown }[] = [];
  const source = createShortcutWebhookSource({
    workspaceId,
    signingSecret,
    accept: async (input) => {
      accepted.push(input);
      return acceptedEmpty();
    },
  });
  await source.start(async () => undefined);
  const response = await source.handle(signedRequest());

  assert.equal(response.status, 200);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]?.workspaceId, workspaceId);
  assert.equal(accepted[0]?.deliveryId, `${webhookId}:456`);
  assert.deepEqual(accepted[0]?.payload, {
    workspaceId,
    webhookId,
    actorId,
    storyId: 123,
    commentId: 456,
    occurredAt: "2026-10-10T12:00:00Z",
  });
});
