import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { z } from "zod";
import { expect, it } from "vitest";
import { createHubApplication } from "../../app.js";
import type { AgentEvent } from "../../daemons/agents/index.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { deriveAgentExecutionCompletionToken } from "../../agent-executions/completion-token.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { OutputExecutorRegistry } from "../../execution-capabilities/outputs.js";
import { configurationBundleFixture } from "../../test-utils/configuration-bundle.js";
import {
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../../test-utils/project-configuration.js";
import { ScheduleTestDaemon } from "../../triggers/schedule/test-daemon.js";
import { createShortcutRegistration } from "./index.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const botMemberId = "00000000-0000-4000-8000-000000000003";
const connectionId = "00000000-0000-4000-8000-000000000004";
const secret = "shortcut-test-signing-secret";
const token = "shortcut-test-api-token";
const completionSecret = "shortcut-test-completion-secret";
const createdAt = "2026-10-10T12:00:00Z";

interface CommentJson {
  id: number;
  story_id: number;
  text: string;
  author_id: string;
  created_at: string;
  updated_at: string;
  parent_id: number | null;
  member_mention_ids: string[];
  external_id: string | null;
  deleted: boolean;
}

function comment(id = 456, overrides: Partial<CommentJson> = {}): CommentJson {
  return {
    id,
    story_id: 123,
    text: "@devbot investigate this",
    author_id: actorId,
    created_at: createdAt,
    updated_at: createdAt,
    parent_id: null,
    member_mention_ids: [botMemberId],
    external_id: null as string | null,
    deleted: false,
    ...overrides,
  };
}

function delivery(id = randomUUID(), commentId = 456, memberId = actorId) {
  return {
    id,
    changed_at: createdAt,
    member_id: memberId,
    actions: [
      {
        action: "create",
        entity_type: "story-comment",
        id: commentId,
        author_id: memberId,
        app_url: `https://app.shortcut.com/sample/story/123#activity-${commentId}`,
      },
    ],
  };
}

async function fixture(options: { continuation?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hub-shortcut-workflow-"));
  const bundle = await embeddedDatabaseRuntime(root);
  const database = createDatabase(bundle.runtime, bundle.locks);
  const daemon = new ScheduleTestDaemon();
  const listeners = new Set<(event: AgentEvent) => void>();
  const promptedAgentIds: string[] = [];
  const send = daemon.agents.send.bind(daemon.agents);
  daemon.agents.send = async (agentId, messageId, text) => {
    promptedAgentIds.push(agentId);
    await send(agentId, messageId, text);
  };
  daemon.agents.watch = async (_agentId, listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const comments = [comment()];
  const posts: { url: string; body: { text: string; parent_id: number; external_id: string } }[] =
    [];
  const reactions: { method: string; commentId: number; emoji: string }[] = [];
  let failCommentRead = false;
  const registration = createShortcutRegistration({
    database,
    auth: null,
    applicationBaseUrl: "https://hub.test",
    configurationVersion: 7,
    configuration: { apiToken: token, webhookSecret: secret },
    identity: { provider: "shortcut", id: workspaceId, name: "Example", memberId: botMemberId },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("Shortcut-Token"), token);
      assert.equal(request.redirect, "error");
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.app.shortcut.com");
      if (url.pathname.endsWith("/reactions")) {
        const found = comments.find(
          (value) => url.pathname === `/api/v3/stories/123/comments/${value.id}/reactions`,
        );
        assert.ok(found, `unexpected Shortcut reaction request: ${request.url}`);
        assert.ok(request.method === "POST" || request.method === "DELETE");
        const body = z
          .object({ emoji: z.string().min(1) })
          .strict()
          .parse(await request.json());
        reactions.push({ method: request.method, commentId: found.id, emoji: body.emoji });
        return request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json([{ emoji: body.emoji }], { status: 201 });
      }
      if (request.method === "POST") {
        assert.equal(url.pathname, "/api/v3/stories/123/comments");
        const body = z
          .object({
            text: z.string(),
            parent_id: z.number(),
            external_id: z.string(),
          })
          .strict()
          .parse(await request.json());
        posts.push({ url: request.url, body });
        const reply = comment(900 + posts.length, {
          text: body.text,
          author_id: botMemberId,
          parent_id: body.parent_id,
          external_id: body.external_id,
        });
        comments.push(reply);
        return Response.json(reply);
      }
      assert.equal(request.method, "GET");
      if (url.pathname === "/api/v3/stories/123") {
        return Response.json({
          id: 123,
          name: "Investigate a problem",
          description: "Story context",
          app_url: "https://app.shortcut.com/sample/story/123",
          comments,
        });
      }
      const found = comments.find(
        (value) => url.pathname === `/api/v3/stories/123/comments/${value.id}`,
      );
      assert.ok(found, `unexpected Shortcut request: ${request.url}`);
      if (failCommentRead) {
        failCommentRead = false;
        return Response.json({ error: "test provider unavailable" }, { status: 503 });
      }
      return Response.json(found);
    },
  });
  const outputs = new OutputExecutorRegistry();
  registration.outputs.forEach((output) => outputs.register(output));
  const application = createHubApplication({
    database,
    entitlements: createUnlimitedEntitlementsService(),
    providerFactories: registration.triggerProviders,
    outputRegistry: outputs,
    publicApi: { status: "unavailable" },
    publicBaseUrl: "https://hub.test",
    completionTokenSecret: completionSecret,
    daemonConnectionForId: (id) => (id === TEST_DAEMON_ID ? daemon : undefined),
  });
  try {
    await bundle.runtime.migrate();
    await bundle.runtime.query(
      "insert into organization (id, name, slug) values ('shortcut-org', 'Shortcut', 'shortcut')",
    );
    await enrollTestDaemon(database, "shortcut-org");
    await bundle.runtime.query(
      `insert into shortcut_connections (id, organization_id, workspace_id, provider_application_id, slug, workspace_name, bot_member_id, api_token)
       values ($1, 'shortcut-org', $2, $2, 'sample', 'Example', $3, $4)`,
      [connectionId, workspaceId, botMemberId, token],
    );
    if (options.continuation) {
      assert.ok(application.hub.agentValidator);
      await new OrganizationTriggerStore(
        database,
        "shortcut-org",
        application.hub.agentValidator,
      ).save({
        userId: null,
        yaml: dump({
          name: "mention",
          on: { "shortcut.mention": { connection: "sample", filters: { from_users: [actorId] } } },
          run: {
            target: { daemon: TEST_DAEMON_SLUG, cwd: "/workspace" },
            agent: { provider: "codex", mode: "full-access" },
            prompt: "Investigate ${{ paseo.context }}",
            continuation: { mode: "conversation" },
          },
        }),
      });
    } else {
      const projectId = randomUUID();
      await bundle.runtime.query(
        "insert into projects (id, organization_id, name, slug) values ($1, 'shortcut-org', 'Default', 'default')",
        [projectId],
      );
      const store = application.configurationForProject(projectId);
      const revision = await store.insertManualBundleRevision({
        userId: null,
        files: configurationBundleFixture(
          dump({
            environments: [
              { name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/workspace" },
            ],
            triggers: [
              {
                name: "mention",
                on: "shortcut.mention",
                max_runtime: "1h",
                filters: { connection: "sample", from_users: [actorId] },
                steps: [
                  {
                    id: "work",
                    environment: "runner",
                    max_runtime: "10m",
                    idle_timeout: "5m",
                    agent: { provider: "codex" },
                    prompt: [{ text: "Investigate ${{ paseo.context }}" }],
                    allow_outputs: [{ type: "shortcut.reply", max: 1, required: true }],
                  },
                ],
              },
            ],
          }),
        ),
      });
      await store.activate(revision.id);
    }
    await application.hub.start(registration.sources);
  } catch (error) {
    await application.hub.stop();
    await database.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    database,
    bundle,
    application,
    daemon,
    comments,
    posts,
    reactions,
    promptedAgentIds,
    emit(event: AgentEvent) {
      for (const listener of listeners) listener(event);
    },
    failNextCommentRead() {
      failCommentRead = true;
    },
    async post(payload: ReturnType<typeof delivery>) {
      const body = JSON.stringify(payload);
      const endpoint = registration.requests.find((request) => request.name === "shortcut.events");
      assert.ok(endpoint);
      return endpoint.handle(
        new Request("https://hub.test/api/integrations/shortcut/events", {
          method: "POST",
          body,
          headers: { "Payload-Signature": createHmac("sha256", secret).update(body).digest("hex") },
        }),
      );
    },
    async receipts() {
      return (
        await bundle.runtime.query<{
          id: string;
          delivery_id: string;
          accepted_routes: unknown[];
          dropped_reason: string | null;
        }>(
          "select id, delivery_id, accepted_routes, dropped_reason from provider_event_receipts order by received_at",
        )
      ).rows;
    },
    async executions() {
      const rows = await bundle.runtime.query<{ id: string }>(
        "select id from agent_executions order by id",
      );
      return Promise.all(
        rows.rows.map(async (row) => {
          const execution = await database.findAgentExecutionById(row.id);
          assert.ok(execution);
          return execution;
        }),
      );
    },
    async execution() {
      const rows = await bundle.runtime.query<{ id: string }>("select id from agent_executions");
      assert.equal(rows.rows.length, 1);
      const execution = await database.findAgentExecutionById(rows.rows[0]!.id);
      assert.ok(execution);
      return execution;
    },
    async callTool(executionId: string, name: string, args: Record<string, unknown>) {
      const response = await application.operations.handleExecutionCapabilities(
        new Request("https://hub.test/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${deriveAgentExecutionCompletionToken(completionSecret, executionId)}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        executionId,
      );
      assert.equal(response.status, 200);
      const body = z
        .object({
          result: z.object({
            isError: z.boolean().optional(),
            content: z.array(z.object({ type: z.literal("text"), text: z.string().min(1) })).min(1),
          }),
        })
        .parse(await response.json());
      assert.notEqual(body.result.isError, true, JSON.stringify(body.result));
      return body.result.content;
    },
    async close() {
      await application.hub.stop();
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("dispatches a signed native Shortcut comment through Hub and replies to its story/root", async () => {
  const test = await fixture();
  try {
    assert.equal((await test.post(delivery())).status, 200);
    await test.application.hub.processWorkflowOutbox();
    await expect.poll(() => test.daemon.prompts.length).toBe(1);
    assert.equal(test.daemon.launches.length, 1);
    await expect
      .poll(() => test.reactions)
      .toEqual([
        { method: "DELETE", commentId: 456, emoji: ":white_check_mark:" },
        { method: "POST", commentId: 456, emoji: ":hourglass_flowing_sand:" },
      ]);
    assert.ok(test.daemon.prompts[0]?.includes("Story context"));
    const execution = await test.execution();
    assert.deepEqual(execution.outputContext, {
      provider: "shortcut",
      workspaceId,
      storyId: 123,
      parentId: 456,
    });
    await test.callTool(execution.id, "reply", { content: "Investigated the problem." });
    assert.equal(test.posts.length, 1);
    const post = test.posts[0];
    assert.ok(post);
    assert.ok(post.body.external_id.startsWith(`paseo-hub:${execution.id}:`));
    assert.ok(
      z.uuid().safeParse(post.body.external_id.slice(`paseo-hub:${execution.id}:`.length)).success,
    );
    assert.deepEqual(post, {
      url: "https://api.app.shortcut.com/api/v3/stories/123/comments",
      body: {
        text: "Investigated the problem.",
        parent_id: 456,
        external_id: post.body.external_id,
      },
    });
  } finally {
    await test.close();
  }
}, 30_000);

it("continues a same-thread follow-up on the original agent and keeps replies rooted", async () => {
  const test = await fixture({ continuation: true });
  try {
    assert.equal((await test.post(delivery())).status, 200);
    await test.application.hub.processWorkflowOutbox();
    await expect.poll(() => test.daemon.prompts.length).toBe(1);
    const first = await test.execution();
    assert.ok(first.daemonAgentId);
    test.emit({
      type: "agent_stream",
      agentId: first.daemonAgentId,
      timestamp: new Date().toISOString(),
      event: { type: "thread_started", provider: "codex", sessionId: "shortcut-thread" },
    });
    await expect.poll(async () => (await test.execution()).status).toBe("running");
    const followupAt = "2026-10-10T12:00:02Z";
    test.comments.push(
      comment(457, {
        parent_id: 456,
        text: "@devbot follow up on this",
        created_at: followupAt,
        updated_at: followupAt,
      }),
    );
    const payload = { ...delivery(randomUUID(), 457), changed_at: followupAt };
    assert.equal((await test.post(payload)).status, 200);
    await test.application.hub.processWorkflowOutbox();
    await expect.poll(() => test.daemon.prompts.length).toBe(2);
    const executions = await test.executions();
    assert.equal(executions.length, 2);
    const next = executions.find((execution) => execution.id !== first.id);
    assert.ok(next);
    assert.equal(next.daemonAgentId, first.daemonAgentId);
    assert.equal(next.agentSessionId, first.agentSessionId);
    assert.equal(
      next.launchIntent?.continuation?.key,
      JSON.stringify(["shortcut", workspaceId, 123, 456]),
    );
    assert.deepEqual(test.promptedAgentIds, [first.daemonAgentId, first.daemonAgentId]);
    assert.equal(test.daemon.launches.length, 1);
    assert.deepEqual(next.outputContext, first.outputContext);
    await test.callTool(first.id, "reply", { content: "Original investigation." });
    await test.callTool(next.id, "reply", { content: "Follow-up investigation." });
    await test.callTool(first.id, "finish_execution", {});
    await test.callTool(next.id, "finish_execution", {});
    test.emit({
      type: "agent_stream",
      agentId: first.daemonAgentId,
      timestamp: new Date().toISOString(),
      event: { type: "turn_completed", provider: "codex" },
    });
    await test.application.hub.processWorkflowOutbox();
    assert.equal(test.posts.length, 2);
    for (const commentId of [456, 457]) {
      await expect
        .poll(() => test.reactions.filter((reaction) => reaction.commentId === commentId))
        .toEqual([
          { method: "DELETE", commentId, emoji: ":white_check_mark:" },
          { method: "POST", commentId, emoji: ":hourglass_flowing_sand:" },
          { method: "DELETE", commentId, emoji: ":hourglass_flowing_sand:" },
          { method: "POST", commentId, emoji: ":white_check_mark:" },
        ]);
    }
    for (const post of test.posts) {
      assert.equal(post.url, "https://api.app.shortcut.com/api/v3/stories/123/comments");
      expect(post.body).toMatchObject({ parent_id: 456 });
    }
  } finally {
    await test.close();
  }
}, 30_000);

it("recovers accepted receipt handoff after provider read failure, dispatching and replying once", async () => {
  const test = await fixture();
  try {
    const payload = delivery();
    test.failNextCommentRead();
    const failed = await test.post(payload);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "event_handoff_unavailable" });
    const [receipt] = await test.receipts();
    assert.ok(receipt);
    assert.equal(receipt.delivery_id, `${payload.id}:456`);
    assert.equal(receipt.accepted_routes.length, 1);
    assert.equal(receipt.dropped_reason, null);
    assert.deepEqual(await test.database.findTriggerRunsByProviderEventReceiptId(receipt.id), []);
    assert.equal(test.daemon.prompts.length, 0);
    assert.equal(test.daemon.launches.length, 0);
    assert.equal(test.posts.length, 0);

    // A persisted ACCEPTED receipt must replay its routes, not become a no-op duplicate.
    assert.equal((await test.post(payload)).status, 200);
    await test.application.hub.processWorkflowOutbox();
    await expect.poll(() => test.daemon.prompts.length).toBe(1);
    const execution = await test.execution();
    await test.callTool(execution.id, "reply", { content: "Recovered the accepted delivery." });
    await test.callTool(execution.id, "finish_execution", {});
    assert.equal((await test.post(payload)).status, 200);
    await test.application.hub.processWorkflowOutbox();
    assert.deepEqual(await test.receipts(), [receipt]);
    assert.equal(
      (await test.database.findTriggerRunsByProviderEventReceiptId(receipt.id)).length,
      1,
    );
    assert.equal((await test.execution()).id, execution.id);
    assert.equal(test.daemon.prompts.length, 1);
    assert.equal(test.daemon.launches.length, 1);
    assert.equal(test.posts.length, 1);
    expect(test.posts[0]?.body).toMatchObject({
      text: "Recovered the accepted delivery.",
      parent_id: 456,
    });
  } finally {
    await test.close();
  }
}, 30_000);

it("does not dispatch or reply to a bot-authored mention", async () => {
  const test = await fixture();
  try {
    test.comments[0]!.author_id = botMemberId;
    assert.equal((await test.post(delivery(randomUUID(), 456, botMemberId))).status, 200);
    await test.application.hub.processWorkflowOutbox();
    assert.deepEqual(await test.executions(), []);
    assert.equal(test.daemon.launches.length, 0);
    assert.equal(test.daemon.prompts.length, 0);
    assert.equal(test.posts.length, 0);
  } finally {
    await test.close();
  }
}, 30_000);

it("replays an identical accepted delivery without a second agent dispatch or reply", async () => {
  const test = await fixture();
  try {
    const payload = delivery();
    assert.equal((await test.post(payload)).status, 200);
    const [receipt] = await test.receipts();
    assert.ok(receipt);
    assert.equal(receipt.accepted_routes.length, 1);
    assert.equal((await test.post(payload)).status, 200);
    await test.application.hub.processWorkflowOutbox();
    await expect.poll(() => test.daemon.prompts.length).toBe(1);
    const execution = await test.execution();
    await test.callTool(execution.id, "reply", { content: "One reply only." });
    await test.callTool(execution.id, "finish_execution", {});
    await test.application.hub.processWorkflowOutbox();

    assert.equal((await test.post(payload)).status, 200);
    await test.application.hub.processWorkflowOutbox();
    const runs = await test.database.findTriggerRunsByProviderEventReceiptId(receipt.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "succeeded");
    assert.equal((await test.execution()).id, execution.id);
    assert.equal(test.daemon.launches.length, 1);
    assert.equal(test.daemon.prompts.length, 1);
    assert.equal(test.posts.length, 1);
    assert.deepEqual(await test.receipts(), [receipt]);
  } finally {
    await test.close();
  }
}, 30_000);
