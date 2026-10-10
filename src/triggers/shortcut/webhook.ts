import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderEventAcceptance } from "../../db/types.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { reportFailure } from "../../failures/index.js";
import { normalizeShortcutCommentEvents, type NormalizedShortcutCommentEvent } from "./events.js";

export interface ShortcutWebhookSourceOptions {
  workspaceId: string;
  signingSecret: string;
  accept(input: {
    workspaceId: string;
    deliveryId: string;
    signatureHash: string;
    source: "shortcut.comment";
    payload: unknown;
    receivedAt: Date;
    dropReason?: "configuration_unavailable";
  }): Promise<ProviderEventAcceptance>;
}

export interface ShortcutWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

export function createShortcutWebhookSource(
  options: ShortcutWebhookSourceOptions,
): ShortcutWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();
  return {
    async handle(request) {
      if (request.method !== "POST")
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      const signature = request.headers.get("Payload-Signature");
      if (signature === null || !/^[a-f0-9]{64}$/iu.test(signature)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await readBoundedRequestBody(request, 1_048_576);
      if (body instanceof Response) return body;
      const expected = createHmac("sha256", options.signingSecret).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
        return new Response("Unauthorized", { status: 401 });
      }
      let events: NormalizedShortcutCommentEvent[];
      try {
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        events = normalizeShortcutCommentEvents(payload, options.workspaceId);
      } catch {
        return Response.json({ error: "invalid_shortcut_event" }, { status: 400 });
      }
      try {
        for (const event of events) {
          const acceptance = await options.accept({
            workspaceId: options.workspaceId,
            deliveryId: `${event.webhookId}:${event.commentId}`,
            signatureHash: createHash("sha256")
              .update(body)
              .update(`:${event.commentId}`)
              .digest("hex"),
            source: "shortcut.comment",
            payload: event,
            receivedAt: new Date(),
            ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" as const } : {}),
          });
          if (acceptance.status === "accepted") {
            await Promise.all(
              acceptance.events.flatMap((accepted) =>
                Array.from(handlers, (handler) => handler(accepted)),
              ),
            );
          }
        }
        return new Response("OK", { status: 200 });
      } catch (error) {
        reportFailure(error, {
          operation: "shortcut.event.handoff",
          component: "triggers",
          provider: "shortcut",
        });
        return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
      }
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}
