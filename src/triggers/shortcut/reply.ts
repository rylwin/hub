import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { ShortcutWorkspaceClient } from "./provider.js";

const ReplyArgsSchema = z.object({ content: z.string().min(1) }).strict();
const OutputContextSchema = z.object({
  provider: z.literal("shortcut"),
  workspaceId: z.string().uuid(),
  storyId: z.number().int().positive().safe(),
  parentId: z.number().int().positive().safe(),
});

export function createShortcutReplyExecutor(options: {
  connectionForWorkspace(workspaceId: string): Promise<ShortcutWorkspaceClient | undefined>;
}): OutputExecutor {
  return async (input) => {
    const args = ReplyArgsSchema.parse(input.args);
    const context = OutputContextSchema.parse(input.outputContext);
    const connection = await options.connectionForWorkspace(context.workspaceId);
    if (connection === undefined) throw new Error("Shortcut connection unavailable");
    const externalId =
      input.attemptId === undefined
        ? undefined
        : `paseo-hub:${input.agentExecutionId}:${input.attemptId}`;
    if (externalId !== undefined) {
      const story = await connection.client.readStory(context.storyId);
      if (story === undefined || story.id !== context.storyId)
        throw new Error("Shortcut story unavailable");
      const correlated = story.comments.filter((comment) => comment.externalId === externalId);
      if (
        correlated.some(
          (comment) =>
            comment.deleted ||
            comment.text !== args.content ||
            comment.parentId !== context.parentId ||
            comment.authorId !== connection.botMemberId,
        )
      )
        throw new Error("Shortcut reply correlation conflict");
      if (correlated.length > 0) return;
    }
    await connection.client.createComment({
      storyId: context.storyId,
      parentId: context.parentId,
      text: args.content,
      ...(externalId === undefined ? {} : { externalId }),
    });
  };
}
