import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import type { ConnectionStatus } from "../connections/functions.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectDashboard } from "./dashboard.js";
import { OrganizationConnectionsPanel, ProjectOverviewPanel } from "./panels.js";

const state = vi.hoisted(() => ({ operator: false }));
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("./context.js", () => ({
  useRouteTenant: () => ({
    account: { id: "user-1" },
    organization: { id: "org-1", slug: "acme" },
    project: { id: "project-1", slug: "hub" },
  }),
}));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({ isInstanceOperator: state.operator }),
}));
vi.mock("../connections/result.js", () => ({ useConnectionReturn: () => [undefined, vi.fn()] }));
vi.mock("../connections/functions.js", () => ({
  connectionStatus: vi.fn(),
  startConnection: vi.fn(),
  disconnectConnection: vi.fn(),
}));
vi.mock("./functions.js", () => ({
  organizationSnapshot: vi.fn(),
  projectSnapshot: vi.fn(),
  archiveProject: vi.fn(),
  activityRunSnapshot: vi.fn(),
  updateProjectSlug: vi.fn(),
}));

async function fixture() {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
    ],
  });
  await database.createProject({
    organizationId: "org-1",
    name: "Hub",
    slug: "hub",
    createdByUserId: "user-1",
  });
  const auth: AuthServer = {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
  const dashboard = new ProjectDashboard(database, auth, undefined);
  const request = new Request("https://hub.test/o/acme/projects/hub");
  const organization = await dashboard.organizationSnapshot(request, { organizationSlug: "acme" });
  const project = await dashboard.projectSnapshot(request, {
    organizationSlug: "acme",
    projectSlug: "hub",
  });
  const status: ConnectionStatus = {
    canManage: true,
    github: { status: "notConfigured" },
    discord: { status: "notConfigured" },
    slack: { status: "notConfigured" },
    linear: { status: "notConfigured" },
    shortcut: { status: "disconnected" },
  };
  return {
    organization,
    project,
    status,
    markup(panel: ReactNode = <OrganizationConnectionsPanel />) {
      const client = new QueryClient();
      client.setQueryData(["organization", "user-1", "org-1"], {
        status: "ok",
        data: organization,
      });
      client.setQueryData(["project", "user-1", "org-1", "project-1"], {
        status: "ok",
        data: project,
      });
      client.setQueryData(["connection-status", "user-1", "org-1"], { status: "ok", data: status });
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>{panel}</QueryClientProvider>,
      );
    },
  };
}

afterEach(() => {
  state.operator = false;
});

it("offers app setup only to an instance operator when Shortcut is not configured", async () => {
  const hub = await fixture();
  hub.status.shortcut = { status: "notConfigured" };
  assert.doesNotMatch(hub.markup(), /Set up the Shortcut app|<h2[^>]*>Shortcut<\/h2>/);
  state.operator = true;
  assert.match(hub.markup(), /href="\/apps"[^>]*>Set up the Shortcut app<\/a>/);
});

it("shows Shortcut connections read-only to members", async () => {
  const hub = await fixture();
  hub.organization.capabilities = { ...hub.organization.capabilities, manageResources: false };
  hub.status.canManage = false;
  hub.status.shortcut = { status: "connected" };
  hub.organization.connections.shortcut.push({
    id: "shortcut-1",
    slug: "acme-shortcut",
    workspaceId: "workspace-1",
    workspaceName: "Acme workspace",
    botMemberId: "bot-1",
  });
  const html = hub.markup();
  assert.match(html, /acme-shortcut/);
  assert.doesNotMatch(html, /Connect Shortcut|Reauthorize Shortcut|Actions for acme-shortcut/);
});

it("counts a Shortcut-only organization as connected in the project overview", async () => {
  const hub = await fixture();
  hub.project.connections.shortcut.push({
    id: "shortcut-1",
    slug: "acme-shortcut",
    workspaceId: "workspace-1",
    workspaceName: "Acme workspace",
    botMemberId: "bot-1",
  });
  const html = hub.markup(<ProjectOverviewPanel />);
  assert.match(html, /1 organization connections/);
  assert.match(html, />Ready<\/span>/);
});

it.each([
  ["connected", "Connected"],
  ["requiresReauthorization", "Reauthorization required"],
  ["disconnected", "Disconnected"],
  ["notConfigured", "Not configured"],
] as const)("renders Shortcut rows using the loaded %s status", async (status, label) => {
  const hub = await fixture();
  hub.organization.connections.shortcut.push({
    id: "shortcut-1",
    slug: "acme-shortcut",
    workspaceId: "workspace-1",
    workspaceName: "Acme workspace",
    botMemberId: "bot-1",
  });
  hub.status.shortcut = { status };
  const html = hub.markup();
  assert.match(html, /acme-shortcut/);
  assert.match(html, /workspace workspace-1/);
  assert.ok(html.includes(`>${label}</span>`), `missing status: ${label}`);
  assert.match(html, /aria-label="Actions for acme-shortcut"/);
});

it("offers Shortcut reauthorization using the loaded connection status", async () => {
  const hub = await fixture();
  hub.status.shortcut = { status: "requiresReauthorization" };
  assert.match(hub.markup(), />Reauthorize Shortcut<\/button>/);
});

it("offers a Shortcut card and connect action for a configured disconnected workspace", async () => {
  const hub = await fixture();
  const html = hub.markup();
  assert.match(html, /<h[23][^>]*>Shortcut<\/h[23]>/);
  assert.match(html, />Connect Shortcut<\/button>/);
});
