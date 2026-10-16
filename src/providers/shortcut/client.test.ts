import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createShortcutApiClient, ShortcutApiError } from "./client.js";

const origin = "https://api.app.shortcut.com/api/v3";

describe("Shortcut API client", () => {
  it("adds a reaction to the specified story comment with header-only authentication", async () => {
    const client = createShortcutApiClient({
      apiToken: "reaction-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/stories/42/comments/8/reactions`);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Shortcut-Token"), "reaction-token");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(init?.body, JSON.stringify({ emoji: ":hourglass_flowing_sand:" }));
        return new Response(JSON.stringify([{ emoji: ":hourglass_flowing_sand:" }]), {
          status: 201,
        });
      },
    });
    await client.addReaction({ storyId: 42, commentId: 8, emoji: ":hourglass_flowing_sand:" });
  });
  it("removes a reaction with a JSON DELETE and accepts 204 without reading JSON", async () => {
    const client = createShortcutApiClient({
      apiToken: "reaction-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/stories/42/comments/8/reactions`);
        assert.equal(init?.method, "DELETE");
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Shortcut-Token"), "reaction-token");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(init?.body, JSON.stringify({ emoji: ":white_check_mark:" }));
        const response = new Response(null, { status: 204 });
        response.json = async () => {
          throw new Error("must not read DELETE JSON");
        };
        return response;
      },
    });
    await client.removeReaction({ storyId: 42, commentId: 8, emoji: ":white_check_mark:" });
  });
  it.each(["member", "story", "comment", "create"] as const)(
    "refuses redirects on token-bearing %s requests",
    async (operation) => {
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async (_url, init) => {
          assert.equal(init?.redirect, "error");
          if (operation === "member")
            return json({
              id: "bot",
              name: "Paseo",
              workspace2: { id: "workspace", name: "Acme" },
            });
          if (operation === "story")
            return json({
              id: 42,
              name: "Fix",
              description: "Details",
              app_url: "https://app.shortcut.com/acme/story/42",
              comments: [],
            });
          return json(commentResponse());
        },
      });
      if (operation === "member") await client.readMember();
      else if (operation === "story") await client.readStory(42);
      else if (operation === "comment") await client.readComment({ storyId: 42, commentId: 7 });
      else await client.createComment({ storyId: 42, text: "Reply" });
    },
  );
  it("reads the bot member and workspace with header-only authentication", async () => {
    const client = createShortcutApiClient({
      apiToken: "test-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/member`);
        assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).get("Shortcut-Token"), "test-token");
        assert.equal(init?.body, undefined);
        return json({ id: "bot", name: "Paseo", workspace2: { id: "workspace", name: "Acme" } });
      },
    });

    assert.deepEqual(await client.readMember(), {
      id: "bot",
      name: "Paseo",
      workspaceId: "workspace",
      workspaceName: "Acme",
    });
  });
  it("reads a story with its complete discussion and bot mentions", async () => {
    const client = createShortcutApiClient({
      apiToken: "story-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/stories/42`);
        assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).get("Shortcut-Token"), "story-token");
        return json({
          id: 42,
          name: "Fix it",
          description: "Details",
          app_url: "https://app.shortcut.com/acme/story/42",
          comments: [
            commentResponse(),
            commentResponse({ id: 8, parent_id: 7, text: null, deleted: true }),
          ],
        });
      },
    });

    assert.deepEqual(await client.readStory(42), {
      id: 42,
      name: "Fix it",
      description: "Details",
      url: "https://app.shortcut.com/acme/story/42",
      comments: [commentData(), { ...commentData(), id: 8, text: "", parentId: 7, deleted: true }],
    });
  });
  it("reads the full triggering comment on its story", async () => {
    const client = createShortcutApiClient({
      apiToken: "comment-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/stories/42/comments/8`);
        assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).get("Shortcut-Token"), "comment-token");
        return json(commentResponse({ id: 8, parent_id: 7, external_id: "event-1" }));
      },
    });
    assert.deepEqual(await client.readComment({ storyId: 42, commentId: 8 }), {
      ...commentData(),
      id: 8,
      parentId: 7,
      externalId: "event-1",
    });
  });
  it("replies on the same story and thread with correlation, without impersonation", async () => {
    const client = createShortcutApiClient({
      apiToken: "post-token",
      fetch: async (url, init) => {
        assert.equal(url, `${origin}/stories/42/comments`);
        assert.equal(init?.method, "POST");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Shortcut-Token"), "post-token");
        assert.equal(headers.get("content-type"), "application/json");
        assert.ok(typeof init?.body === "string");
        assert.deepEqual(JSON.parse(init.body), {
          text: "Done",
          parent_id: 7,
          external_id: "run-1",
        });
        return json(
          commentResponse({
            id: 8,
            text: "Done",
            author_id: "bot",
            parent_id: 7,
            external_id: "run-1",
          }),
        );
      },
    });
    const input = {
      storyId: 42,
      text: "Done",
      parentId: 7,
      externalId: "run-1",
      author_id: "other",
    };
    assert.deepEqual(await client.createComment(input), {
      ...commentData(),
      id: 8,
      text: "Done",
      authorId: "bot",
      parentId: 7,
      externalId: "run-1",
    });
  });
  it.each(["addReaction", "removeReaction"] as const)(
    "%s throws sanitized status-only errors including missing reactions",
    async (method) => {
      for (const status of [301, 401, 403, 404, 429, 500]) {
        const client = createShortcutApiClient({
          apiToken: "secret-token",
          fetch: async () => new Response("secret-token private response body", { status }),
        });
        await assert.rejects(
          client[method]({ storyId: 42, commentId: 8, emoji: ":hourglass_flowing_sand:" }),
          { name: "ShortcutApiError", message: `Shortcut API HTTP ${status}`, status },
        );
      }
    },
  );
  it("throws sanitized status-only errors for HTTP failures, including rate limits", async () => {
    for (const status of [401, 403, 429, 500]) {
      const client = createShortcutApiClient({
        apiToken: "secret-token",
        fetch: async () => new Response("secret-token private response body", { status }),
      });
      for (const operation of [
        () => client.readMember(),
        () => client.readStory(42),
        () => client.readComment({ storyId: 42, commentId: 7 }),
        () => client.createComment({ storyId: 42, text: "Done" }),
      ]) {
        await assert.rejects(operation, {
          name: "ShortcutApiError",
          message: `Shortcut API HTTP ${status}`,
          status,
        });
      }
    }
  });
  it("returns undefined only for missing GET stories and comments", async () => {
    const client = createShortcutApiClient({
      apiToken: "test-token",
      fetch: async () => new Response("private not-found body", { status: 404 }),
    });
    assert.equal(await client.readStory(42), undefined);
    assert.equal(await client.readComment({ storyId: 42, commentId: 7 }), undefined);
    for (const operation of [
      () => client.readMember(),
      () => client.createComment({ storyId: 42, text: "Done" }),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof ShortcutApiError);
        assert.equal(error.status, 404);
        assert.equal(error.message, "Shortcut API HTTP 404");
        return true;
      });
    }
  });
  it.each(["addReaction", "removeReaction"] as const)(
    "%s validates positive safe IDs and nonempty emoji before requesting",
    async (method) => {
      let requests = 0;
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async () => {
          requests += 1;
          return json([]);
        },
      });
      const input = { storyId: 42, commentId: 8, emoji: ":hourglass_flowing_sand:" };
      for (const id of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(client[method]({ ...input, storyId: id }), { name: "ZodError" });
        await assert.rejects(client[method]({ ...input, commentId: id }), { name: "ZodError" });
      }
      for (const emoji of ["", " ", "\t\n"]) {
        await assert.rejects(client[method]({ ...input, emoji }), { name: "ZodError" });
      }
      assert.equal(requests, 0);
    },
  );
  it("rejects unsafe or non-positive integer IDs before any request", async () => {
    let requests = 0;
    const client = createShortcutApiClient({
      apiToken: "test-token",
      fetch: async () => {
        requests += 1;
        return json(commentResponse());
      },
    });
    for (const id of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const operation of [
        () => client.readStory(id),
        () => client.readComment({ storyId: id, commentId: 7 }),
        () => client.readComment({ storyId: 42, commentId: id }),
        () => client.createComment({ storyId: id, text: "Done" }),
        () => client.createComment({ storyId: 42, text: "Done", parentId: id }),
      ]) {
        await assert.rejects(operation);
      }
    }
    assert.equal(requests, 0);
  });
  it("validates member and workspace response shapes", async () => {
    for (const response of [
      {},
      { id: "bot", name: "Bot", workspace: { id: "workspace", name: "Acme" } },
      { id: "bot", name: 123, workspace2: { id: "workspace", name: "Acme" } },
      { id: "bot", name: "Bot", workspace2: { id: "", name: "Acme" } },
    ]) {
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async () => json(response),
      });
      await assert.rejects(() => client.readMember(), { name: "ZodError" });
    }
  });

  it("validates story fields and requires the complete comments array", async () => {
    for (const patch of [
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { name: null },
      { description: null },
      { app_url: "not-a-url" },
      { comments: undefined },
      { comments: {} },
    ]) {
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async () => json(storyResponse(patch)),
      });
      await assert.rejects(() => client.readStory(42), { name: "ZodError" });
    }
  });

  it("validates full StoryComment shapes in every comment response", async () => {
    for (const patch of [
      { id: 0 },
      { story_id: 1.5 },
      { text: null },
      { author_id: "" },
      { created_at: "yesterday" },
      { parent_id: -1 },
      { parent_id: undefined },
      { member_mention_ids: [7] },
      { member_mention_ids: undefined },
      { external_id: 7 },
      { external_id: undefined },
      { deleted: "false" },
    ]) {
      const response = commentResponse(patch);
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async (url) =>
          json(url === `${origin}/stories/42` ? storyResponse({ comments: [response] }) : response),
      });
      await assert.rejects(() => client.readStory(42), { name: "ZodError" });
      await assert.rejects(() => client.readComment({ storyId: 42, commentId: 7 }), {
        name: "ZodError",
      });
      await assert.rejects(() => client.createComment({ storyId: 42, text: "Done" }), {
        name: "ZodError",
      });
    }
  });

  it("preserves optional updated_at on comment and story responses", async () => {
    const updatedAt = "2026-05-06T12:01:00+00:00";
    const response = commentResponse({ updated_at: updatedAt });
    const client = createShortcutApiClient({
      apiToken: "test-token",
      fetch: async (url) =>
        json(url === `${origin}/stories/42` ? storyResponse({ comments: [response] }) : response),
    });
    assert.deepEqual(await client.readComment({ storyId: 42, commentId: 7 }), {
      ...commentData(),
      updatedAt,
    });
    assert.deepEqual((await client.readStory(42))?.comments, [{ ...commentData(), updatedAt }]);
    assert.deepEqual(await client.createComment({ storyId: 42, text: "Done" }), {
      ...commentData(),
      updatedAt,
    });
  });

  it.each(["yesterday", "2026-05-06", null, 123])(
    "validates updated_at when supplied: %j",
    async (updatedAt) => {
      const response = commentResponse({ updated_at: updatedAt });
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async (url) =>
          json(url === `${origin}/stories/42` ? storyResponse({ comments: [response] }) : response),
      });
      await assert.rejects(client.readComment({ storyId: 42, commentId: 7 }), { name: "ZodError" });
      await assert.rejects(client.readStory(42), { name: "ZodError" });
      await assert.rejects(client.createComment({ storyId: 42, text: "Done" }), {
        name: "ZodError",
      });
    },
  );

  it("omits optional fields for top-level comments", async () => {
    const client = createShortcutApiClient({
      apiToken: "test-token",
      fetch: async (_url, init) => {
        assert.ok(typeof init?.body === "string");
        assert.deepEqual(JSON.parse(init.body), { text: "Done" });
        return json(commentResponse({ text: "Done" }));
      },
    });
    assert.deepEqual(await client.createComment({ storyId: 42, text: "Done" }), {
      ...commentData(),
      text: "Done",
    });
  });

  it("never retries a comment POST even with an external correlation ID", async () => {
    for (const failure of [429, 500, "network"] as const) {
      let requests = 0;
      const client = createShortcutApiClient({
        apiToken: "test-token",
        fetch: async () => {
          requests += 1;
          if (failure === "network") throw new Error("Network unavailable");
          return new Response("private response", { status: failure });
        },
      });
      await assert.rejects(() =>
        client.createComment({ storyId: 42, text: "Done", externalId: "run-1" }),
      );
      assert.equal(requests, 1);
    }
  });
});

function storyResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "Fix it",
    description: "Details",
    app_url: "https://app.shortcut.com/acme/story/42",
    comments: [commentResponse()],
    ...overrides,
  };
}

function commentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    story_id: 42,
    text: "@Paseo help",
    author_id: "author",
    created_at: "2026-05-06T12:00:00Z",
    parent_id: null,
    member_mention_ids: ["bot"],
    external_id: null,
    deleted: false,
    ...overrides,
  };
}

function commentData() {
  return {
    id: 7,
    storyId: 42,
    text: "@Paseo help",
    authorId: "author",
    createdAt: "2026-05-06T12:00:00Z",
    parentId: null,
    memberMentionIds: ["bot"],
    externalId: null,
    deleted: false,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
