import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import { createDatabase } from "./pg.js";

it("durably accepts Shortcut comments and replays the same receipt for handoff recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-shortcut-acceptance-"));
  const bundle = await embeddedDatabaseRuntime(root);
  const database = createDatabase(bundle.runtime, bundle.locks);
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const connectionId = "00000000-0000-4000-8000-000000000002";
  const projectId = "00000000-0000-4000-8000-000000000003";
  try {
    await bundle.runtime.migrate();
    await bundle.runtime.query(
      `insert into organization (id, name, slug) values ('shortcut-org', 'Shortcut', 'shortcut')`,
    );
    await bundle.runtime.query(
      `insert into projects (id, organization_id, name, slug) values ($1, 'shortcut-org', 'Default', 'default')`,
      [projectId],
    );
    await bundle.runtime.query(
      `insert into shortcut_connections (id, organization_id, workspace_id, provider_application_id, slug, workspace_name, bot_member_id, api_token) values ($1, 'shortcut-org', $2, $2, 'shortcut', 'Example', 'bot', 'test-token')`,
      [connectionId, workspaceId],
    );
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "shortcut-test-config",
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id, [
      { provider: "shortcut", connectionId, resourceId: null, triggerName: "mention" },
    ]);
    const input = {
      workspaceId,
      deliveryId: "webhook:123",
      source: "shortcut.comment",
      signatureHash: "test-signature",
      payload: { storyId: 42, commentId: 123 },
      receivedAt: new Date("2026-10-10T12:00:00Z"),
    };
    const first = await database.acceptShortcutEvent(input);
    assert.equal(first.status, "accepted");
    if (first.status !== "accepted") throw new Error("expected Shortcut acceptance");
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]?.organizationId, "shortcut-org");
    assert.equal(first.events[0]?.projectId, projectId);
    assert.equal(first.events[0]?.connectionId, connectionId);
    const duplicate = await database.acceptShortcutEvent(input);
    // Accepted routes replay after a crash between receipt persistence and delivery handoff.
    // The downstream trigger store deduplicates the stable receipt/delivery identity.
    assert.deepEqual(duplicate, first);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
