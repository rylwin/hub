import assert from "node:assert/strict";
import { dump } from "js-yaml";
import { it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { configurationBundleFixture } from "../test-utils/configuration-bundle.js";
import { ProjectConfigurationStore } from "./store.js";

it("compiles a Shortcut mention to its organization-scoped workspace connection", async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const connectionId = "00000000-0000-4000-8000-000000000002";
  const database = createMemoryDatabase({
    shortcutConnections: [
      {
        id: connectionId,
        organizationId: "org_1",
        slug: "example-shortcut",
        providerApplicationId: workspaceId,
        workspaceId,
        workspaceName: "Example",
        botMemberId: "bot",
        apiToken: "test-token",
      },
    ],
  });
  await enrollTestDaemon(database);
  const project = await database.createProject({
    organizationId: "org_1",
    name: "Shortcut",
    slug: "shortcut",
    createdByUserId: "user-1",
  });
  const store = new ProjectConfigurationStore(database, project.id);
  const revision = await store.insertManualBundleRevision({
    userId: "user-1",
    files: configurationBundleFixture(
      dump({
        environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
        triggers: [
          {
            name: "mentions",
            on: "shortcut.mention",
            filters: { connection: "example-shortcut", from_users: ["ryan"] },
            max_runtime: "1h",
            steps: [
              {
                id: "work",
                environment: "runner",
                max_runtime: "10m",
                idle_timeout: "1m",
                agent: { provider: "codex" },
                prompt: [{ text: "Help" }],
              },
            ],
          },
        ],
      }),
    ),
  });
  const active = await store.activate(revision.id);
  assert.equal(active.configuration.triggers[0]?.filters?.connectionId, connectionId);
  assert.deepEqual(active.configuration.triggers[0]?.filters?.from_users, ["ryan"]);
  const receipt = await database.acceptShortcutEvent({
    workspaceId,
    source: "shortcut.comment",
    deliveryId: "event:123",
    payload: {},
    receivedAt: new Date(),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("expected scoped Shortcut route");
  assert.equal(receipt.events[0]?.projectId, project.id);
});
