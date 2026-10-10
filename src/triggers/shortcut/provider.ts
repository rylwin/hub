import { reportFailure } from "../../failures/index.js";
import type { CompiledTriggerFilter } from "../../config/compiler.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  ShortcutApiClient,
  ShortcutComment,
  ShortcutStory,
} from "../../providers/shortcut/client.js";
import type {
  AcceptedTriggerProviderMatch,
  TriggerProvider,
  TriggerProviderMatch,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  NormalizedShortcutCommentEventSchema,
  type NormalizedShortcutCommentEvent,
} from "./events.js";

export interface ShortcutOutputContext {
  provider: "shortcut";
  workspaceId: string;
  storyId: number;
  parentId: number;
}

export interface ShortcutTriggerContext {
  provider: "shortcut";
  target: ShortcutOutputContext;
  event: {
    shortcut: {
      workspace: { id: string };
      actor: { id: string };
      story: { id: number; title: string; description: string; url: string };
      comment: { id: number; body: string; created_at: string };
    };
  };
}

export interface ShortcutContextMessage {
  id: number;
  content: string;
  author: { id: string } | null;
  created_at: string | null;
}

export interface ShortcutMaterializedContext {
  shortcut: ShortcutTriggerContext["event"]["shortcut"] & {
    thread: {
      status: "available" | "incomplete" | "unavailable";
      messages: ShortcutContextMessage[];
    };
  };
}

export interface ShortcutWorkspaceClient {
  botMemberId: string;
  client: ShortcutApiClient;
}

export function createShortcutTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionForWorkspace(workspaceId: string): Promise<ShortcutWorkspaceClient | undefined>;
}): TriggerProvider<
  "shortcut",
  ShortcutTriggerContext,
  ShortcutOutputContext,
  ShortcutMaterializedContext
> {
  return {
    name: "shortcut",
    eventNames: ["shortcut.comment"],
    async match(external) {
      if (external.source !== "shortcut.comment") return "no_trigger_for_source";
      const event = NormalizedShortcutCommentEventSchema.parse(external.payload);
      const stored = await options
        .configurationStoreForProject(external.projectId)
        .getRevision(external.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      const triggers = stored.configuration.triggers.filter(
        (trigger) => trigger.on === "shortcut.mention",
      );
      if (triggers.length === 0) return "no_trigger_for_source";
      const connection = await options.connectionForWorkspace(event.workspaceId);
      if (connection === undefined) return "configuration_unavailable";
      if (event.actorId === connection.botMemberId) return "trigger_filters_rejected";
      const comment = await connection.client.readComment({
        storyId: event.storyId,
        commentId: event.commentId,
      });
      // Capture the current story snapshot, not an as-of reconstruction.
      const story = await connection.client.readStory(event.storyId);
      if (comment === undefined || story === undefined) return "trigger_filters_rejected";
      if (!matchesNewMention(event, comment, story, connection.botMemberId))
        return "trigger_filters_rejected";
      const outputContext: ShortcutOutputContext = {
        provider: "shortcut",
        workspaceId: event.workspaceId,
        storyId: story.id,
        parentId: comment.parentId ?? comment.id,
      };
      const matches: TriggerProviderMatch<ShortcutTriggerContext, ShortcutOutputContext>[] = [];
      for (const trigger of triggers) {
        if (!matchesShortcutScope(trigger.filters, external.connectionId, event.actorId)) continue;
        const invocation = parseInvocation(comment.text, trigger.inputs);
        if (
          invocation.status === "accepted" &&
          !matchesInputFilters(invocation.inputs, trigger.filters?.inputs)
        )
          continue;
        const match: Omit<
          AcceptedTriggerProviderMatch<ShortcutTriggerContext, ShortcutOutputContext>,
          "invocation"
        > = {
          conversation: {
            key: JSON.stringify(["shortcut", event.workspaceId, story.id, outputContext.parentId]),
            label: "Shortcut thread",
          },
          triggerName: trigger.name,
          triggerContext: {
            provider: "shortcut",
            target: outputContext,
            event: {
              shortcut: {
                workspace: { id: event.workspaceId },
                actor: { id: event.actorId },
                story: {
                  id: story.id,
                  title: story.name,
                  description: story.description,
                  url: story.url,
                },
                comment: { id: comment.id, body: comment.text, created_at: comment.createdAt },
              },
            },
          },
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        };
        if (invocation.status === "accepted") matches.push({ ...match, invocation });
        else matches.push({ ...match, invocation });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch) {
      const shortcut = launch.triggerContext.event.shortcut;
      const root: ShortcutContextMessage = {
        id: shortcut.story.id,
        content:
          shortcut.story.description.length === 0
            ? shortcut.story.title
            : `${shortcut.story.title}\n\n${shortcut.story.description}`,
        author: null,
        created_at: null,
      };
      try {
        const connection = await options.connectionForWorkspace(shortcut.workspace.id);
        if (connection === undefined) return shortcutThreadContext(shortcut, "unavailable", [root]);
        const story = await connection.client.readStory(shortcut.story.id);
        if (story === undefined || story.id !== shortcut.story.id)
          return shortcutThreadContext(shortcut, "unavailable", [root]);
        const rootCommentId = launch.triggerContext.target.parentId;
        const comments = story.comments
          .filter((comment) => !comment.deleted)
          .filter((comment) => comment.id === rootCommentId || comment.parentId === rootCommentId)
          .filter(
            (comment) => Date.parse(comment.createdAt) < Date.parse(shortcut.comment.created_at),
          )
          .filter(
            (comment) =>
              Date.parse(comment.updatedAt ?? comment.createdAt) <
              Date.parse(shortcut.comment.created_at),
          )
          .sort(
            (left, right) =>
              Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id - right.id,
          );
        const messages = comments.slice(-49).map((comment) => ({
          id: comment.id,
          content: comment.text,
          author: { id: comment.authorId },
          created_at: comment.createdAt,
        }));
        return shortcutThreadContext(shortcut, comments.length > 49 ? "incomplete" : "available", [
          root,
          ...messages,
        ]);
      } catch (error) {
        reportFailure(
          error,
          {
            operation: "shortcut.story.history.hydrate",
            component: "triggers",
            provider: "shortcut",
          },
          {
            diagnostic: { workspaceId: shortcut.workspace.id, storyId: shortcut.story.id },
          },
        );
        return shortcutThreadContext(shortcut, "unavailable", [root]);
      }
    },
  };
}

function matchesShortcutScope(
  filters: CompiledTriggerFilter | undefined,
  connectionId: string | null | undefined,
  actorId: string,
): boolean {
  if (filters?.connectionId !== undefined && filters.connectionId !== connectionId) return false;
  if (filters?.from_users !== undefined && !filters.from_users.includes(actorId)) return false;
  return true;
}

function matchesNewMention(
  event: NormalizedShortcutCommentEvent,
  comment: ShortcutComment,
  story: ShortcutStory,
  botMemberId: string,
): boolean {
  // Older payloads omit updated_at: creation time is only a fallback, not proof
  // of an unedited body. Live payload verification is still required.
  return (
    story.id === event.storyId &&
    comment.id === event.commentId &&
    comment.storyId === event.storyId &&
    !comment.deleted &&
    comment.authorId === event.actorId &&
    !(Date.parse(comment.updatedAt ?? comment.createdAt) > Date.parse(event.occurredAt)) &&
    comment.memberMentionIds.includes(botMemberId) &&
    comment.authorId !== botMemberId
  );
}

function shortcutThreadContext(
  shortcut: ShortcutTriggerContext["event"]["shortcut"],
  status: ShortcutMaterializedContext["shortcut"]["thread"]["status"],
  messages: ShortcutContextMessage[],
): ShortcutMaterializedContext {
  let remaining = 32000;
  let truncated = false;
  const bounded: ShortcutContextMessage[] = [];
  for (const message of messages) {
    if (message.content.length > remaining) truncated = true;
    if (remaining === 0) continue;
    const content = message.content.slice(0, remaining);
    bounded.push({ ...message, content });
    remaining -= content.length;
  }
  return {
    shortcut: {
      ...shortcut,
      thread: {
        status: truncated && status === "available" ? "incomplete" : status,
        messages: bounded,
      },
    },
  };
}
