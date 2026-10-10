import assert from "node:assert/strict";
import { it } from "vitest";
import { normalizeShortcutCommentEvents } from "./events.js";

// The v3 REST reference documents HistoryActionStoryCommentCreate. Outgoing
// webhooks use these actions; the comment URL identifies its containing story.
const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const webhookId = "00000000-0000-4000-8000-000000000003";

it("locates a newly created comment without relying on primary_id", () => {
  const events = normalizeShortcutCommentEvents(
    {
      id: webhookId,
      version: "v1",
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
    },
    workspaceId,
  );

  assert.deepEqual(events, [
    {
      workspaceId,
      webhookId,
      actorId,
      storyId: 123,
      commentId: 456,
      occurredAt: "2026-10-10T12:00:00Z",
    },
  ]);
});

it.each([
  "https://other.test/example/story/123/test",
  "https://app.shortcut.com/example/not-a-story/123/test",
])("rejects a comment URL outside a Shortcut story: %s", (appUrl) => {
  assert.throws(() =>
    normalizeShortcutCommentEvents(
      {
        id: webhookId,
        changed_at: "2026-10-10T12:00:00Z",
        member_id: actorId,
        actions: [{ entity_type: "story-comment", action: "create", id: 456, app_url: appUrl }],
      },
      workspaceId,
    ),
  );
});

it.each([
  { id: 456 },
  { id: "456", app_url: "https://app.shortcut.com/example/story/123/test" },
  { id: 456, app_url: "not-a-url" },
])("rejects malformed recognized comment creation instead of dropping it: %j", (action) => {
  assert.throws(() =>
    normalizeShortcutCommentEvents(
      {
        id: webhookId,
        member_id: actorId,
        changed_at: "2026-10-10T12:00:00Z",
        actions: [{ entity_type: "story-comment", action: "create", ...action }],
      },
      workspaceId,
    ),
  );
});

it.each(["1e3", "0x7b", "123.0", "not-an-id", "0", "-1", "9007199254740992"])(
  "rejects malformed story IDs in recognized comment URLs: %s",
  (storyId) => {
    assert.throws(() =>
      normalizeShortcutCommentEvents(
        {
          id: webhookId,
          member_id: actorId,
          changed_at: "2026-10-10T12:00:00Z",
          actions: [
            {
              entity_type: "story-comment",
              action: "create",
              id: 456,
              app_url: `https://app.shortcut.com/example/story/${storyId}/test`,
            },
          ],
        },
        workspaceId,
      ),
    );
  },
);

it("ignores state changes and edits or deletion of an existing comment", () => {
  const events = normalizeShortcutCommentEvents(
    {
      id: webhookId,
      changed_at: "2026-10-10T12:00:00Z",
      member_id: actorId,
      actions: [
        { entity_type: "story", action: "update", id: 123 },
        {
          entity_type: "story-comment",
          action: "update",
          id: 456,
          app_url: "https://app.shortcut.com/example/story/123/test#activity-456",
        },
        { entity_type: "story-comment", action: "delete", id: 456 },
      ],
    },
    workspaceId,
  );

  assert.deepEqual(events, []);
});
