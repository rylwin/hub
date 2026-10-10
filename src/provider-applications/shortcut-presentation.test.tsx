import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider, type UseMutationOptions } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { it, vi } from "vitest";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { guideFor } from "./guides.js";
import type { ProviderApplicationOverview, ProviderApplicationView } from "./index.js";
import { AppSetupEntry, AppsPanel } from "./panel.js";
import { ProviderSection } from "./provider-section.js";
import { beginProviderConnection } from "./functions.js";

const state = vi.hoisted(() => ({ connecting: false }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useMutation: (options: UseMutationOptions) => {
      const mutation = actual.useMutation(options);
      return Object.is(options.mutationFn, beginProviderConnection) && state.connecting
        ? { ...mutation, isPending: true }
        : mutation;
    },
  };
});
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./functions.js", () => ({
  providerApplicationsOverview: vi.fn(),
  beginProviderConnection: vi.fn(),
  configureSlackSocketApplication: vi.fn(),
  retrySlackSocketDelivery: vi.fn(),
  verifyAndSaveProviderApplication: vi.fn(),
}));
vi.mock("../auth/functions.js", () => ({ completeAppSetup: vi.fn() }));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({ organization: { id: "org-1" } }),
}));
vi.mock("../connections/result.js", () => ({ useConnectionReturn: () => [undefined] }));

const ignore = () => {};

function view(overrides: Partial<ProviderApplicationView> = {}): ProviderApplicationView {
  return {
    provider: "shortcut",
    status: "notConfigured",
    managedByEnvironment: false,
    identifiers: {},
    identity: null,
    connections: [],
    eventsConfigured: false,
    lastEventAt: null,
    replaceable: true,
    configurationVersion: null,
    ...overrides,
  };
}

const identity = {
  provider: "shortcut",
  id: "workspace-1",
  name: "Acme",
  memberId: "bot-1",
} as const;

function markup(saved: ProviderApplicationView, origin = "http://localhost:6791"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderSection
        guide={guideFor("shortcut")}
        view={saved}
        callbackOrigin={origin}
        surface="apps"
        organizationId="org-1"
        open
        onOpenChange={ignore}
        returned={undefined}
      />
    </QueryClientProvider>,
  );
}

it("renders native Shortcut secret fields locally and never echoes saved secrets", () => {
  const html = markup(
    view({
      identifiers: {
        apiToken: "never-echo-token",
        webhookSecret: "never-echo-signing-secret",
        clientId: "not-a-client-id",
      },
    }),
  );
  assert.match(html, /name="apiToken"/);
  assert.match(html, /name="webhookSecret"/);
  assert.equal(html.match(/type="password"/g)?.length, 2);
  assert.doesNotMatch(html, /name="clientId"|name="clientSecret"/);
  assert.doesNotMatch(html, /never-echo|not-a-client-id/);
  assert.match(html, /Verify and save/);
  assert.match(html, /keeping the dashboard private/);
  assert.match(html, /Read/);
  assert.match(html, /Create Story Comments/);
});

it("shows verified workspace and bot identity without claiming event delivery", () => {
  const html = markup(
    view({ status: "verified", identity, eventsConfigured: true, configurationVersion: 1 }),
  );
  assert.match(html, /Configured workspace/);
  assert.match(html, /Acme/);
  assert.match(html, /Workspace ID/);
  assert.match(html, /workspace-1/);
  assert.match(html, /Bot member ID/);
  assert.match(html, /bot-1/);
  assert.match(html, /Waiting for a connection/);
  assert.match(html, /Connect configured workspace/);
  assert.doesNotMatch(html, /Connect another workspace|continue to Shortcut/);
});

it("says connecting instead of opening an external authorization", () => {
  state.connecting = true;
  try {
    const html = markup(
      view({ status: "verified", identity, eventsConfigured: true, configurationVersion: 1 }),
    );
    assert.match(html, />Connecting…<\/button>/);
    assert.doesNotMatch(html, />Opening…<\/button>/);
  } finally {
    state.connecting = false;
  }
});

it("offers no second Shortcut workspace after the configured workspace is connected", () => {
  const html = markup(
    view({
      status: "connected",
      identity,
      eventsConfigured: true,
      configurationVersion: 1,
      connections: [
        { id: "workspace-1", name: "Acme", applicationId: "workspace-1", status: "connected" },
      ],
      identifiers: { apiToken: "never-echo-token", webhookSecret: "never-echo-signing-secret" },
    }),
    "https://hub.private.example",
  );
  assert.match(html, /Waiting for the first event/);
  assert.doesNotMatch(html, /Connect configured workspace|Connect another workspace|never-echo/);
});

it("gives Shortcut a decorative provider glyph rather than the manual terminal", () => {
  const html = renderToStaticMarkup(<ProviderGlyph provider="shortcut" />);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /lucide-terminal/);
});

it("names Shortcut in both app surface introductions", () => {
  const client = new QueryClient();
  const overview: ProviderApplicationOverview = {
    callbackOrigin: "http://localhost:6791",
    providers: {
      github: view({ provider: "github" }),
      slack: view({ provider: "slack" }),
      discord: view({ provider: "discord" }),
      linear: view({ provider: "linear" }),
      shortcut: view(),
    },
  };
  client.setQueryData(["provider-applications"], { status: "ok", data: overview });
  for (const panel of [
    <AppSetupEntry key="setup" organizationId="org-1" onLeft={ignore} />,
    <AppsPanel key="apps" />,
  ]) {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>{panel}</QueryClientProvider>,
    );
    assert.match(html, /<p[^>]*>[^<]*Shortcut/);
  }
});
