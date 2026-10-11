import { z } from "zod";

const SHORTCUT_API_ORIGIN = "https://api.app.shortcut.com/api/v3";
const MemberResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  workspace2: z.object({ id: z.string().min(1), name: z.string() }),
});

export interface ShortcutMember {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

const PositiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CommentResponseSchema = z.object({
  id: PositiveIdSchema,
  story_id: PositiveIdSchema,
  text: z.string(),
  author_id: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  parent_id: PositiveIdSchema.nullable(),
  member_mention_ids: z.array(z.string().min(1)),
  external_id: z.string().nullable(),
  deleted: z.boolean(),
});
const StoryResponseSchema = z.object({
  id: PositiveIdSchema,
  name: z.string(),
  description: z.string(),
  app_url: z.string().url(),
  comments: z.array(CommentResponseSchema),
});

export interface ShortcutComment {
  id: number;
  storyId: number;
  text: string;
  authorId: string;
  createdAt: string;
  updatedAt?: string;
  parentId: number | null;
  memberMentionIds: string[];
  externalId: string | null;
  deleted: boolean;
}

export interface ShortcutStory {
  id: number;
  name: string;
  description: string;
  url: string;
  comments: ShortcutComment[];
}

export interface ShortcutApiClient {
  addReaction(input: { storyId: number; commentId: number; emoji: string }): Promise<void>;
  removeReaction(input: { storyId: number; commentId: number; emoji: string }): Promise<void>;
  readMember(): Promise<ShortcutMember>;
  readStory(storyId: number): Promise<ShortcutStory | undefined>;
  readComment(input: { storyId: number; commentId: number }): Promise<ShortcutComment | undefined>;
  createComment(input: {
    storyId: number;
    text: string;
    parentId?: number;
    externalId?: string;
  }): Promise<ShortcutComment>;
}

export class ShortcutApiError extends Error {
  constructor(public readonly status: number) {
    super(`Shortcut API HTTP ${status}`);
    this.name = "ShortcutApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new ShortcutApiError(response.status);
  return response.json();
}

/** A server-side token binds this client to one Shortcut workspace connection. */
export function createShortcutApiClient(options: {
  apiToken: string;
  fetch?: typeof fetch;
}): ShortcutApiClient {
  const request: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, { ...init, redirect: "error" });
  async function changeReaction(
    method: "POST" | "DELETE",
    input: Parameters<ShortcutApiClient["addReaction"]>[0],
  ): Promise<void> {
    PositiveIdSchema.parse(input.storyId);
    PositiveIdSchema.parse(input.commentId);
    z.string().trim().min(1).parse(input.emoji);
    const response = await request(
      `${SHORTCUT_API_ORIGIN}/stories/${input.storyId}/comments/${input.commentId}/reactions`,
      {
        method,
        headers: { "Shortcut-Token": options.apiToken, "content-type": "application/json" },
        body: JSON.stringify({ emoji: input.emoji }),
      },
    );
    if (!response.ok) throw new ShortcutApiError(response.status);
  }
  return {
    addReaction: (input) => changeReaction("POST", input),
    removeReaction: (input) => changeReaction("DELETE", input),
    async createComment(input) {
      PositiveIdSchema.parse(input.storyId);
      if (input.parentId !== undefined) PositiveIdSchema.parse(input.parentId);
      const response = await request(`${SHORTCUT_API_ORIGIN}/stories/${input.storyId}/comments`, {
        method: "POST",
        headers: { "Shortcut-Token": options.apiToken, "content-type": "application/json" },
        body: JSON.stringify({
          text: input.text,
          ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
          ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
        }),
      });
      return toComment(CommentResponseSchema.parse(await readJson(response)));
    },
    async readComment(input) {
      PositiveIdSchema.parse(input.storyId);
      PositiveIdSchema.parse(input.commentId);
      const response = await request(
        `${SHORTCUT_API_ORIGIN}/stories/${input.storyId}/comments/${input.commentId}`,
        { method: "GET", headers: { "Shortcut-Token": options.apiToken } },
      );
      if (response.status === 404) return undefined;
      return toComment(CommentResponseSchema.parse(await readJson(response)));
    },
    async readStory(storyId) {
      PositiveIdSchema.parse(storyId);
      const response = await request(`${SHORTCUT_API_ORIGIN}/stories/${storyId}`, {
        method: "GET",
        headers: { "Shortcut-Token": options.apiToken },
      });
      if (response.status === 404) return undefined;
      const story = StoryResponseSchema.parse(await readJson(response));
      return {
        id: story.id,
        name: story.name,
        description: story.description,
        url: story.app_url,
        comments: story.comments.map(toComment),
      };
    },
    async readMember() {
      const response = await request(`${SHORTCUT_API_ORIGIN}/member`, {
        method: "GET",
        headers: { "Shortcut-Token": options.apiToken },
      });
      const member = MemberResponseSchema.parse(await readJson(response));
      return {
        id: member.id,
        name: member.name,
        workspaceId: member.workspace2.id,
        workspaceName: member.workspace2.name,
      };
    },
  };
}

function toComment(comment: z.infer<typeof CommentResponseSchema>): ShortcutComment {
  return {
    id: comment.id,
    storyId: comment.story_id,
    text: comment.text,
    authorId: comment.author_id,
    createdAt: comment.created_at,
    ...(comment.updated_at === undefined ? {} : { updatedAt: comment.updated_at }),
    parentId: comment.parent_id,
    memberMentionIds: comment.member_mention_ids,
    externalId: comment.external_id,
    deleted: comment.deleted,
  };
}
