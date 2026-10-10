import assert from "node:assert/strict";
import { it } from "vitest";
import type { ShortcutApiClient, ShortcutComment } from "../../providers/shortcut/client.js";
import { createShortcutReplyExecutor } from "./reply.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const botMemberId = "00000000-0000-4000-8000-000000000002";

it.each(["storyId", "parentId", "workspaceId", "externalId"])(
  "rejects extra reply argument %s before resolving a connection",
  async (key) => {
    let connections = 0;
    const execute = createShortcutReplyExecutor({
      connectionForWorkspace: async () => {
        connections++;
        return undefined;
      },
    });
    await assert.rejects(
      execute({
        agentExecutionId: "execution-1",
        toolType: "shortcut.reply",
        args: { content: "Result", [key]: "another-target" },
        outputContext: { provider: "shortcut", workspaceId, storyId: 123, parentId: 456 },
      }),
      /Unrecognized key/,
    );
    assert.equal(connections, 0);
  },
);

const outputContext = { provider: "shortcut", workspaceId, storyId: 123, parentId: 456 };
const replyComment: ShortcutComment = {
  id: 789,
  storyId: 123,
  text: "Result",
  authorId: botMemberId,
  createdAt: "2026-10-10T12:01:00Z",
  parentId: 456,
  memberMentionIds: [],
  externalId: null,
  deleted: false,
};

function replyFixture(comments: ShortcutComment[] = []) {
  const posted: Parameters<ShortcutApiClient["createComment"]>[0][] = [];
  const client: ShortcutApiClient = {
    readMember: async () => {
      throw new Error("unexpected member request");
    },
    readComment: async () => {
      throw new Error("unexpected comment request");
    },
    readStory: async (id) => {
      assert.equal(id, 123);
      return {
        id: 123,
        name: "Story",
        description: "Context",
        url: "https://app.shortcut.com/example/story/123/story",
        comments,
      };
    },
    createComment: async (input) => {
      posted.push(input);
      return replyComment;
    },
  };
  const execute = createShortcutReplyExecutor({
    connectionForWorkspace: async (id) => {
      assert.equal(id, workspaceId);
      return { botMemberId, client };
    },
  });
  return { execute, posted, client };
}

it("correlates a reply with its execution and attempt ID", async () => {
  const { execute, posted } = replyFixture();
  await execute({
    agentExecutionId: "execution-1",
    attemptId: "attempt-1",
    toolType: "shortcut.reply",
    args: { content: "Result" },
    outputContext,
  });
  assert.deepEqual(posted, [
    { storyId: 123, parentId: 456, text: "Result", externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
});

it("reconciles an already posted reply for the same attempt without another POST", async () => {
  const { execute, posted } = replyFixture([
    { ...replyComment, externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
  await execute({
    agentExecutionId: "execution-1",
    attemptId: "attempt-1",
    toolType: "shortcut.reply",
    args: { content: "Result" },
    outputContext,
  });
  assert.deepEqual(posted, []);
});

it("rejects correlated evidence with different text instead of claiming success or posting again", async () => {
  const { execute, posted } = replyFixture([
    { ...replyComment, text: "Different", externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      attemptId: "attempt-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext,
    }),
    /correlation conflict/,
  );
  assert.deepEqual(posted, []);
});

it.each([{ parentId: 999 }, { parentId: null }])(
  "rejects correlated evidence belonging to another parent: %j",
  async (override) => {
    const { execute, posted } = replyFixture([
      { ...replyComment, ...override, externalId: "paseo-hub:execution-1:attempt-1" },
    ]);
    await assert.rejects(
      execute({
        agentExecutionId: "execution-1",
        attemptId: "attempt-1",
        toolType: "shortcut.reply",
        args: { content: "Result" },
        outputContext,
      }),
      /correlation conflict/,
    );
    assert.deepEqual(posted, []);
  },
);

it("rejects correlated evidence authored by someone other than the connected bot", async () => {
  const { execute, posted } = replyFixture([
    { ...replyComment, authorId: workspaceId, externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      attemptId: "attempt-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext,
    }),
    /correlation conflict/,
  );
  assert.deepEqual(posted, []);
});

it("does not reconcile a deleted correlated reply or silently repost it", async () => {
  const { execute, posted } = replyFixture([
    { ...replyComment, deleted: true, externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      attemptId: "attempt-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext,
    }),
    /correlation conflict/,
  );
  assert.deepEqual(posted, []);
});

it("does not reconcile or post against a mismatched story API response", async () => {
  const { execute, posted, client } = replyFixture();
  const readStory = client.readStory.bind(client);
  client.readStory = async (id) => ({ ...(await readStory(id))!, id: 999 });
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      attemptId: "attempt-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext,
    }),
    /Shortcut story unavailable/,
  );
  assert.deepEqual(posted, []);
});

it.each([
  null,
  {},
  { ...outputContext, provider: "linear" },
  { ...outputContext, workspaceId: "bad" },
  { ...outputContext, storyId: 0 },
  { ...outputContext, storyId: "123" },
  { ...outputContext, parentId: null },
  { ...outputContext, parentId: Number.MAX_SAFE_INTEGER + 1 },
])("rejects invalid output context before connection access: %j", async (context) => {
  let calls = 0;
  const execute = createShortcutReplyExecutor({
    connectionForWorkspace: async () => {
      calls++;
      return undefined;
    },
  });
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext: context,
    }),
    { name: "ZodError" },
  );
  assert.equal(calls, 0);
});

it("fails safely when the workspace connection is unavailable", async () => {
  const execute = createShortcutReplyExecutor({ connectionForWorkspace: async () => undefined });
  await assert.rejects(
    execute({
      agentExecutionId: "execution-1",
      attemptId: "attempt-1",
      toolType: "shortcut.reply",
      args: { content: "Result" },
      outputContext,
    }),
    /Shortcut connection unavailable/,
  );
});

it.each(["failure", "missing"])(
  "does not POST if reconciliation read is unavailable: %s",
  async (mode) => {
    const { execute, client, posted } = replyFixture();
    client.readStory = async () => {
      if (mode === "failure") throw new Error("read unavailable");
      return undefined;
    };
    await assert.rejects(
      execute({
        agentExecutionId: "execution-1",
        attemptId: "attempt-1",
        toolType: "shortcut.reply",
        args: { content: "Result" },
        outputContext,
      }),
      /unavailable/,
    );
    assert.deepEqual(posted, []);
  },
);

it("does not automatically retry an uncertain POST and reconciles a later invocation of that attempt", async () => {
  const comments: ShortcutComment[] = [];
  const { execute, client } = replyFixture(comments);
  let posts = 0;
  client.createComment = async (input) => {
    posts++;
    comments.push({ ...replyComment, externalId: input.externalId ?? null });
    throw new Error("response lost after write");
  };
  const input = {
    agentExecutionId: "execution-1",
    attemptId: "attempt-1",
    toolType: "shortcut.reply",
    args: { content: "Result" },
    outputContext,
  };
  await assert.rejects(execute(input), /response lost/);
  assert.equal(posts, 1);
  await execute(input);
  assert.equal(posts, 1);
});

it("does not mistake a different attempt's reply for this attempt", async () => {
  const { execute, posted } = replyFixture([
    { ...replyComment, externalId: "paseo-hub:execution-1:attempt-1" },
  ]);
  await execute({
    agentExecutionId: "execution-1",
    attemptId: "attempt-2",
    toolType: "shortcut.reply",
    args: { content: "Result" },
    outputContext,
  });
  assert.deepEqual(posted, [
    { storyId: 123, parentId: 456, text: "Result", externalId: "paseo-hub:execution-1:attempt-2" },
  ]);
});

it("posts to the triggering story's comment thread without author impersonation", async () => {
  const posted: Parameters<ShortcutApiClient["createComment"]>[0][] = [];
  const reply: ShortcutComment = {
    id: 789,
    storyId: 123,
    text: "Result",
    authorId: botMemberId,
    createdAt: "2026-10-10T12:01:00Z",
    parentId: 456,
    memberMentionIds: [],
    externalId: null,
    deleted: false,
  };
  const client: ShortcutApiClient = {
    readMember: () => Promise.reject(new Error("unexpected member request")),
    readStory: () => Promise.reject(new Error("unexpected story request")),
    readComment: () => Promise.reject(new Error("unexpected comment request")),
    createComment: (input) => {
      posted.push(input);
      return Promise.resolve(reply);
    },
  };
  const execute = createShortcutReplyExecutor({
    connectionForWorkspace: (id) => {
      assert.equal(id, workspaceId);
      return Promise.resolve({ botMemberId, client });
    },
  });
  await execute({
    agentExecutionId: "execution-1",
    toolType: "shortcut.reply",
    args: { content: "Result" },
    outputContext: { provider: "shortcut", workspaceId, storyId: 123, parentId: 456 },
  });

  assert.deepEqual(posted, [{ storyId: 123, parentId: 456, text: "Result" }]);
});
