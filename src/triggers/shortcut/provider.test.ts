import assert from "node:assert/strict";
import { it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { ShortcutApiClient, ShortcutComment } from "../../providers/shortcut/client.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import { createShortcutTriggerProvider } from "./provider.js";
import { NormalizedShortcutCommentEventSchema } from "./events.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const botMemberId = "00000000-0000-4000-8000-000000000003";
const webhookId = "00000000-0000-4000-8000-000000000004";
const comment: ShortcutComment = {
  id: 456,
  storyId: 123,
  text: "@devbot investigate this",
  authorId: actorId,
  createdAt: "2026-10-10T12:00:00Z",
  parentId: null,
  memberMentionIds: [botMemberId],
  externalId: null,
  deleted: false,
};

function clientFor(value: ShortcutComment): ShortcutApiClient {
  return {
    readMember: () =>
      Promise.resolve({ id: botMemberId, name: "Bot", workspaceId, workspaceName: "Example" }),
    readComment: () => Promise.resolve(value),
    readStory: () =>
      Promise.resolve({
        id: 123,
        name: "Investigate a problem",
        description: "Story context",
        url: "https://app.shortcut.com/example/story/123/investigate",
        comments: [value],
      }),
    createComment: () => Promise.reject(new Error("unexpected write during matching")),
  };
}

async function fixture(
  value = comment,
  on = "shortcut.mention",
  client = clientFor(value),
  triggerOverrides: Record<string, unknown> = {},
  connectionId?: string,
) {
  const database = createMemoryDatabase();
  const active = await createActiveProjectConfiguration(
    database,
    {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "mention",
          on,
          max_runtime: "1h",
          filters: { from_users: [actorId] },
          ...triggerOverrides,
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "pi" },
              prompt: [{ text: "Work from ${{ paseo.context }}" }],
            },
          ],
        },
      ],
    },
    { organizationId: "hub-org" },
  );
  if (connectionId !== undefined) {
    const stored = await active.store.getRevision(active.revision.id);
    assert.ok(stored);
    const configuration = {
      ...stored.configuration,
      triggers: stored.configuration.triggers.map((trigger) =>
        Object.assign({}, trigger, {
          filters: { ...trigger.filters, connectionId },
        }),
      ),
    };
    active.revision = await database.insertProjectConfigurationRevision({
      projectId: active.project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: configuration,
      contentHash: "bound-configuration",
      createdByUserId: "test-user",
    });
  }
  const provider = createShortcutTriggerProvider({
    configurationStoreForProject: () => active.store,
    connectionForWorkspace: () => Promise.resolve({ botMemberId, client }),
  });
  const external: ExternalTrigger = {
    providerEventReceiptId: "receipt-1",
    organizationId: "hub-org",
    projectId: active.project.id,
    configurationRevisionId: active.revision.id,
    source: "shortcut.comment",
    deliveryId: `${webhookId}:456`,
    receivedAt: new Date(comment.createdAt),
    connectionId: "00000000-0000-4000-8000-000000000005",
    payload: {
      workspaceId,
      webhookId,
      actorId,
      storyId: 123,
      commentId: 456,
      occurredAt: comment.createdAt,
    },
  };
  return { provider, external, active };
}

it("rejects an external source other than shortcut.comment before parsing", async () => {
  const { provider, external } = await fixture();
  external.source = "linear.comment";
  external.payload = {};
  assert.equal(await provider.match(external), "no_trigger_for_source");
});

it("rejects deleted comments", async () => {
  const { provider, external } = await fixture({ ...comment, deleted: true });
  assert.equal(await provider.match(external), "trigger_filters_rejected");
});

it.each([{ id: 999 }, { storyId: 999 }])(
  "rejects mismatched API comment IDs %j",
  async (override) => {
    const { provider, external } = await fixture({ ...comment, ...override });
    assert.ok((await provider.match(external)) === "trigger_filters_rejected");
  },
);

it("rejects a mismatched API story ID", async () => {
  const client = clientFor(comment);
  const readStory = client.readStory.bind(client);
  client.readStory = async (id) => ({ ...(await readStory(id))!, id: 999 });
  const { provider, external } = await fixture(comment, "shortcut.mention", client);
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("ignores events whose signed actor is the bot even when the author differs", async () => {
  const { provider, external } = await fixture(comment, "shortcut.mention", clientFor(comment), {
    filters: { from_users: [botMemberId] },
  });
  external.payload = {
    ...NormalizedShortcutCommentEventSchema.parse(external.payload),
    actorId: botMemberId,
  };
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("enforces the compiled connection binding", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000006";
  const { provider, external } = await fixture(
    comment,
    "shortcut.mention",
    clientFor(comment),
    {},
    connectionId,
  );
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
  external.connectionId = connectionId;
  assert.ok(Array.isArray(await provider.match(external)));
});

it("filters accepted invocations by declared inputs", async () => {
  const value = { ...comment, text: "mode=review @devbot investigate" };
  const { provider, external } = await fixture(value, "shortcut.mention", clientFor(value), {
    inputs: { mode: { type: "string", required: true } },
    filters: { from_users: [actorId], inputs: { mode: "fix" } },
  });
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("uses thread-scoped conversation keys for roots and follow-up mentions", async () => {
  async function conversation(value: ShortcutComment) {
    const { provider, external } = await fixture(value);
    external.payload = {
      ...NormalizedShortcutCommentEventSchema.parse(external.payload),
      commentId: value.id,
    };
    const result = await provider.match(external);
    assert.ok(typeof result !== "string");
    return result[0]?.conversation;
  }
  const root = await conversation(comment);
  assert.deepEqual(root, {
    key: JSON.stringify(["shortcut", workspaceId, 123, 456]),
    label: "Shortcut thread",
  });
  assert.deepEqual(await conversation({ ...comment, id: 457, parentId: 456 }), root);
  assert.notDeepEqual(await conversation({ ...comment, id: 458 }), root);
});

it("materializes the captured story title and description", async () => {
  const { provider, external } = await fixture();
  const result = await provider.match(external);
  assert.ok(typeof result !== "string" && result[0]);
  assert.ok(typeof provider.materializeContext === "function");
  const context = await provider.materializeContext({
    executionId: "execution",
    organizationId: external.organizationId,
    projectId: external.projectId,
    providerEventReceiptId: external.providerEventReceiptId,
    triggerContext: result[0].triggerContext,
  });
  assert.deepEqual(context.shortcut.thread, {
    status: "available",
    messages: [
      {
        id: 123,
        content: "Investigate a problem\n\nStory context",
        author: null,
        created_at: null,
      },
    ],
  });
  assert.deepEqual(context.shortcut.story, result[0].triggerContext.event.shortcut.story);
});

async function materializeHistory(
  history: ShortcutComment[] | Error,
  storyOverrides: Record<string, unknown> = {},
) {
  const value = { ...comment, parentId: 400 };
  const client = clientFor(value);
  const { provider, external } = await fixture(value, "shortcut.mention", client);
  const result = await provider.match(external);
  assert.ok(typeof result !== "string" && result[0]);
  const readStory = client.readStory.bind(client);
  client.readStory = async (id) => {
    if (history instanceof Error) throw history;
    return { ...(await readStory(id))!, comments: history, ...storyOverrides };
  };
  assert.ok(typeof provider.materializeContext === "function");
  return provider.materializeContext({
    executionId: "execution",
    organizationId: external.organizationId,
    projectId: external.projectId,
    providerEventReceiptId: external.providerEventReceiptId,
    triggerContext: result[0].triggerContext,
  });
}

it("hydrates preceding discussion in chronological order from the API", async () => {
  const history = [
    {
      ...comment,
      id: 401,
      parentId: 400,
      text: "Earlier reply",
      createdAt: "2026-10-10T11:00:00Z",
    },
    { ...comment, id: 400, text: "Thread root", createdAt: "2026-10-10T10:00:00Z" },
  ];
  const context = await materializeHistory(history, {
    name: "Changed title",
    description: "Changed description",
  });
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.content),
    ["Investigate a problem\n\nStory context", "Thread root", "Earlier reply"],
  );
  assert.equal(context.shortcut.thread.status, "available");
});

it("isolates materialized discussion to this root thread", async () => {
  const earlier = { ...comment, createdAt: "2026-10-10T10:00:00Z" };
  const context = await materializeHistory([
    { ...earlier, id: 400 },
    { ...earlier, id: 401, parentId: 400 },
    { ...earlier, id: 402 },
    { ...earlier, id: 403, parentId: 402 },
  ]);
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.id),
    [123, 400, 401],
  );
});

it("excludes deleted history and strictly excludes triggering, simultaneous, and later comments", async () => {
  const context = await materializeHistory([
    { ...comment, id: 400, createdAt: "2026-10-10T10:00:00Z" },
    { ...comment, id: 401, parentId: 400, deleted: true, createdAt: "2026-10-10T11:00:00Z" },
    { ...comment, parentId: 400 },
    { ...comment, id: 457, parentId: 400 },
    { ...comment, id: 458, parentId: 400, createdAt: "2026-10-10T13:00:00Z" },
    { ...comment, id: 459, parentId: 400, createdAt: "invalid" },
  ]);
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.id),
    [123, 400],
  );
  assert.equal(context.shortcut.thread.status, "available");
});

it("excludes history edited in the trigger's coarse timestamp second", async () => {
  const context = await materializeHistory([
    { ...comment, id: 400, createdAt: "2026-10-10T11:00:00Z", updatedAt: comment.createdAt },
  ]);
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.id),
    [123],
  );
});

it("bounds discussion to the latest 49 preceding comments and marks truncation incomplete", async () => {
  const history = Array.from({ length: 50 }, (_, index) => ({
    ...comment,
    id: 500 + index,
    parentId: 400,
    createdAt: "2026-10-10T11:00:00Z",
  }));
  const context = await materializeHistory(history.toReversed());
  assert.equal(context.shortcut.thread.status, "incomplete");
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.id),
    [123, ...Array.from({ length: 49 }, (_, index) => 501 + index)],
  );
  assert.equal((await materializeHistory(history.slice(1))).shortcut.thread.status, "available");
});

it("bounds story and discussion content to 32000 characters total", async () => {
  const context = await materializeHistory([
    { ...comment, id: 400, text: "x".repeat(32000), createdAt: "2026-10-10T11:00:00Z" },
    { ...comment, id: 401, parentId: 400, text: "tail", createdAt: "2026-10-10T11:30:00Z" },
  ]);
  assert.equal(context.shortcut.thread.status, "incomplete");
  assert.equal(
    context.shortcut.thread.messages.reduce((sum, message) => sum + message.content.length, 0),
    32000,
  );
});

it("reports unavailable history on read failure while preserving captured story context", async () => {
  const context = await materializeHistory(new Error("Shortcut unavailable"));
  assert.equal(context.shortcut.thread.status, "unavailable");
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.content),
    ["Investigate a problem\n\nStory context"],
  );
});

it("fails closed when the configuration revision or workspace connection is unavailable", async () => {
  const { provider, external, active } = await fixture();
  assert.equal(
    await provider.match({ ...external, configurationRevisionId: "missing" }),
    "configuration_unavailable",
  );
  const unavailable = createShortcutTriggerProvider({
    configurationStoreForProject: () => active.store,
    connectionForWorkspace: async () => undefined,
  });
  assert.equal(await unavailable.match(external), "configuration_unavailable");
  const matches = await provider.match(external);
  assert.ok(typeof matches !== "string" && matches[0]);
  assert.ok(typeof unavailable.materializeContext === "function");
  const context = await unavailable.materializeContext({
    executionId: "execution",
    organizationId: external.organizationId,
    projectId: external.projectId,
    providerEventReceiptId: external.providerEventReceiptId,
    triggerContext: matches[0].triggerContext,
  });
  assert.equal(context.shortcut.thread.status, "unavailable");
});

it("does not hydrate discussion from a mismatched API story", async () => {
  const context = await materializeHistory(
    [{ ...comment, id: 400, createdAt: "2026-10-10T11:00:00Z" }],
    { id: 999 },
  );
  assert.equal(context.shortcut.thread.status, "unavailable");
  assert.equal(context.shortcut.thread.messages.length, 1);
});

it.each(["mode=fix @devbot investigate", "@devbot missing input"])(
  "preserves invocation parsing outcomes: %s",
  async (text) => {
    const value = { ...comment, text };
    const { provider, external } = await fixture(value, "shortcut.mention", clientFor(value), {
      inputs: { mode: { type: "string", required: true } },
      filters: { from_users: [actorId], inputs: { mode: "fix" } },
    });
    const result = await provider.match(external);
    assert.ok(typeof result !== "string" && result[0]);
    assert.equal(result[0].invocation.prompt, text);
    assert.equal(result[0].invocation.status, text.startsWith("mode=") ? "accepted" : "rejected");
    if (result[0].invocation.status === "accepted")
      assert.deepEqual(result[0].invocation.inputs, { mode: "fix" });
    else
      assert.deepEqual(result[0].invocation.rejection, {
        code: "missing_required",
        inputName: "mode",
      });
  },
);

it.each(["readComment", "readStory"] as const)(
  "does not match unavailable API data from %s or swallow its failure",
  async (method) => {
    const client = clientFor(comment);
    client[method] = async () => undefined;
    const { provider, external } = await fixture(comment, "shortcut.mention", client);
    assert.equal(await provider.match(external), "trigger_filters_rejected");
    client[method] = async () => {
      throw new Error("API unavailable");
    };
    await assert.rejects(provider.match(external), /API unavailable/);
  },
);

it("requires the signed creation actor to be the fetched comment author", async () => {
  const { provider, external } = await fixture({
    ...comment,
    authorId: "00000000-0000-4000-8000-000000000009",
  });
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("rejects a triggering comment edited after the signed creation event", async () => {
  const { provider, external } = await fixture({ ...comment, updatedAt: "2026-10-10T12:00:01Z" });
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("falls back to creation time when updated_at is absent", async () => {
  const { provider, external } = await fixture({ ...comment, createdAt: "2026-10-10T12:00:01Z" });
  assert.ok((await provider.match(external)) === "trigger_filters_rejected");
});

it("excludes history whose edit timestamps are not strictly before trigger creation", async () => {
  const earlier = { ...comment, createdAt: "2026-10-10T11:00:00Z", parentId: 400 };
  const context = await materializeHistory([
    { ...earlier, id: 401, updatedAt: "2026-10-10T12:00:01Z" },
    { ...earlier, id: 402, updatedAt: comment.createdAt },
    { ...earlier, id: 403, updatedAt: "2026-10-10T11:30:00Z" },
    { ...earlier, id: 404 },
  ]);
  assert.deepEqual(
    context.shortcut.thread.messages.map((message) => message.id),
    [123, 403, 404],
  );
});

it.each([undefined, "2026-10-10T12:00:00Z", "2026-10-10T11:59:59Z"])(
  "accepts causal comments without requiring transaction timestamps to be identical (updatedAt=%s)",
  async (updatedAt) => {
    const value = {
      ...comment,
      createdAt: "2026-10-10T11:59:58Z",
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
    const { provider, external } = await fixture(value);
    assert.ok(Array.isArray(await provider.match(external)));
  },
);

it("does not treat display text as a mention of the connected member", async () => {
  const { provider, external } = await fixture({ ...comment, memberMentionIds: [actorId] });
  const result = await provider.match(external);

  assert.equal(result, "trigger_filters_rejected");
});

it("ignores the bot's own comments to prevent reply loops", async () => {
  const { provider, external } = await fixture({ ...comment, authorId: botMemberId });
  const result = await provider.match(external);

  assert.equal(result, "trigger_filters_rejected");
});

it("enforces the configured author allowlist using the webhook actor", async () => {
  const { provider, external } = await fixture({
    ...comment,
    authorId: "00000000-0000-4000-8000-000000000009",
  });
  external.payload = {
    workspaceId,
    webhookId,
    actorId: "00000000-0000-4000-8000-000000000009",
    storyId: 123,
    commentId: 456,
    occurredAt: comment.createdAt,
  };

  assert.equal(await provider.match(external), "trigger_filters_rejected");
});

it("does not match another provider's configured event", async () => {
  const { provider, external } = await fixture(comment, "linear.comment_created");

  assert.equal(await provider.match(external), "no_trigger_for_source");
});

it("matches a comment mentioning the connected bot's member ID", async () => {
  const { provider, external } = await fixture();
  const result = await provider.match(external);
  if (typeof result === "string") throw new Error(`expected a match, got ${result}`);
  const match = result[0];
  if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected an accepted invocation");

  assert.equal(match.invocation.prompt, comment.text);
  assert.deepEqual(match.outputContext, {
    provider: "shortcut",
    workspaceId,
    storyId: 123,
    parentId: 456,
  });
  assert.equal(match.triggerName, "mention");
});
