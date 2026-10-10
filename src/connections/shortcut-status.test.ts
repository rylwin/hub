import assert from "node:assert/strict";
import { it } from "vitest";
import { connectionStatusSchema } from "./functions.js";
import { providerBindingDetail } from "./status.js";

it("names a connected Shortcut binding on the connection surface", () => {
  assert.equal(providerBindingDetail("shortcut", { status: "connected" }), "Shortcut");
});

it.each(["notConfigured", "disconnected", "connected", "requiresReauthorization"] as const)(
  "retains Shortcut connection state %s in the server-function contract",
  (status) => {
    const parsed = connectionStatusSchema.parse({
      canManage: true,
      github: { status: "disconnected" },
      discord: { status: "disconnected" },
      slack: { status: "disconnected" },
      linear: { status: "disconnected" },
      shortcut: { status },
    });
    assert.deepEqual(parsed.shortcut, { status });
  },
);
