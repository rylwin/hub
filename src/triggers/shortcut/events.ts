import { z } from "zod";

export const NormalizedShortcutCommentEventSchema = z.object({
  workspaceId: z.string().uuid(),
  webhookId: z.string().uuid(),
  actorId: z.string().uuid(),
  storyId: z.number().int().positive().safe(),
  commentId: z.number().int().positive().safe(),
  occurredAt: z.string().datetime(),
});

export type NormalizedShortcutCommentEvent = z.infer<typeof NormalizedShortcutCommentEventSchema>;

const ShortcutEnvelopeSchema = z.object({
  id: z.string().uuid(),
  member_id: z.string().uuid(),
  changed_at: z.string().datetime(),
  actions: z.array(z.unknown()),
});

const CommentCreateActionSchema = z.object({
  entity_type: z.literal("story-comment"),
  action: z.literal("create"),
  id: z.number(),
  app_url: z.string().url(),
});

export function normalizeShortcutCommentEvents(
  payload: unknown,
  workspaceId: string,
): NormalizedShortcutCommentEvent[] {
  const envelope = ShortcutEnvelopeSchema.parse(payload);
  return envelope.actions.flatMap((action) => {
    if (
      typeof action !== "object" ||
      action === null ||
      !("entity_type" in action) ||
      action.entity_type !== "story-comment" ||
      !("action" in action) ||
      action.action !== "create"
    )
      return [];
    const parsed = CommentCreateActionSchema.parse(action);
    const url = new URL(parsed.app_url);
    const storyId = url.pathname.split("/")[3];
    if (
      url.origin !== "https://app.shortcut.com" ||
      url.pathname.split("/")[2] !== "story" ||
      storyId === undefined ||
      !/^[1-9][0-9]*$/u.test(storyId)
    ) {
      throw new Error("Invalid Shortcut story comment URL");
    }
    return [
      NormalizedShortcutCommentEventSchema.parse({
        workspaceId,
        webhookId: envelope.id,
        actorId: envelope.member_id,
        storyId: Number(storyId),
        commentId: parsed.id,
        occurredAt: envelope.changed_at,
      }),
    ];
  });
}
