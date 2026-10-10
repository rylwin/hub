import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";
import { ConnectionConflictError, DatabaseUnavailableError } from "../../db/errors.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import type { ProviderApplicationIdentity } from "../../provider-applications/index.js";
import { createShortcutTriggerProvider } from "../../triggers/shortcut/provider.js";
import { createShortcutReplyExecutor } from "../../triggers/shortcut/reply.js";
import { createShortcutWebhookSource } from "../../triggers/shortcut/webhook.js";
import type { ProviderRegistration } from "../registration.js";
import { createShortcutApiClient } from "./client.js";
import {
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  newConnectionState,
  stateHash,
  requiredConnectionId,
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
} from "../../connections/shared.js";
import { connectionReturnUrl } from "../../connections/result-contract.js";

export interface ShortcutRegistrationConfiguration {
  apiToken: string;
  webhookSecret: string;
}

export interface CreateShortcutRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  configuration: ShortcutRegistrationConfiguration;
  identity: Extract<ProviderApplicationIdentity, { provider: "shortcut" }>;
  configurationVersion?: number;
  fetch?: typeof fetch;
}

async function startConnection(
  options: CreateShortcutRegistrationOptions,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const { database, auth } = options;
  if (database === null || auth === null)
    return Response.json({ error: "provider_not_configured" }, { status: 409 });
  const rejected = auth.rejectCookieMutation(request);
  if (rejected !== undefined) return rejected;
  try {
    const access = await manageConnectionAccess(auth, database, request);
    const verifier = stateHash(newConnectionState());
    await database.startConnectionAttempt({
      provider: "shortcut",
      stateVerifier: verifier,
      access: connectionAccess(access),
      lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
      configurationVersion: options.configurationVersion ?? 0,
      providerApplicationId: options.identity.id,
      callbackOrigin: options.applicationBaseUrl,
      configurationSnapshot: { provider: "shortcut", ...options.configuration },
      expectedConfigurationVersion: null,
      activateConfiguration: false,
    });
    const member = await createShortcutApiClient({
      apiToken: options.configuration.apiToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }).readMember();
    if (member.workspaceId !== options.identity.id || member.id !== options.identity.memberId)
      throw new ConnectionConflictError();
    await database.bindShortcutConnection({
      stateVerifier: verifier,
      phase: "shortcut_verification",
      access: { sessionId: access.account.session.id, userId: access.account.account.id },
      providerApplicationId: options.identity.id,
      workspaceId: member.workspaceId,
      workspaceName: member.workspaceName,
      botMemberId: member.id,
      apiToken: options.configuration.apiToken,
    });
    return Response.json({
      url: connectionReturnUrl(options.applicationBaseUrl, access.returnRoute, {
        provider: "shortcut",
        result: "shortcut_connected",
      }).toString(),
    });
  } catch (error) {
    return connectionActionFailure(error, "shortcut", "start");
  }
}

async function disconnectConnection(
  options: CreateShortcutRegistrationOptions,
  request: Request,
): Promise<Response> {
  const { database, auth } = options;
  if (database === null || auth === null)
    return Response.json({ error: "provider_not_configured" }, { status: 409 });
  const rejected = auth.rejectCookieMutation(request);
  if (rejected !== undefined) return rejected;
  try {
    const access = await manageConnectionAccess(auth, database, request);
    await database.disconnectConnection(
      "shortcut",
      requiredConnectionId(request),
      connectionAccess(access),
    );
    return Response.json({ disconnected: true });
  } catch (error) {
    return connectionActionFailure(error, "shortcut", "disconnect");
  }
}

export function createShortcutRegistration(
  options: CreateShortcutRegistrationOptions,
): ProviderRegistration {
  const database = options.database;
  const connectionForWorkspace = async (workspaceId: string) => {
    if (workspaceId !== options.identity.id) return undefined;
    const connection = await database?.findShortcutConnection(workspaceId);
    if (
      connection === undefined ||
      connection.botMemberId !== options.identity.memberId ||
      connection.apiToken !== options.configuration.apiToken
    )
      return undefined;
    return {
      botMemberId: connection.botMemberId,
      client: createShortcutApiClient({
        apiToken: connection.apiToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
  };
  const webhook = createShortcutWebhookSource({
    workspaceId: options.identity.id,
    signingSecret: options.configuration.webhookSecret,
    accept: (input) => {
      if (database === null) return Promise.reject(new DatabaseUnavailableError());
      return database.acceptShortcutEvent({
        ...input,
        providerApplicationId: options.identity.id,
        providerConfigurationVersion: options.configurationVersion ?? 0,
      });
    },
  });
  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.applicationBaseUrl,
    },
    connection: {
      name: "shortcut",
      status: (connections) => {
        if (connections.shortcut.length === 0) return { status: "disconnected" };
        const stale = connections.shortcut.some(
          (connection) =>
            connection.botMemberId !== options.identity.memberId ||
            connection.apiToken !== options.configuration.apiToken,
        );
        return { status: stale ? "requiresReauthorization" : "connected" };
      },
      actions: {
        start: (request) => startConnection(options, request),
        disconnect: (request) => disconnectConnection(options, request),
      },
    },
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createShortcutTriggerProvider({ configurationStoreForProject, connectionForWorkspace }),
    ],
    sources: [webhook],
    outputs: [
      {
        type: "shortcut.reply",
        tool: replyOutputTool,
        available: outputContextProvider("shortcut"),
        execute: createShortcutReplyExecutor({ connectionForWorkspace }),
      },
    ],
    requests: [{ name: "shortcut.events", handle: (request) => webhook.handle(request) }],
  };
}
