import assert from "node:assert/strict";
import { it } from "vitest";
import { connectionReturnCopy, readConnectionReturn } from "./result-contract.js";

it.each(["shortcut_connected", "shortcut_disconnected"] as const)(
  "displays native Shortcut connection result %s",
  (result) => {
    const returned = readConnectionReturn(
      new URL(`https://hub.test/o/example/connections?app=shortcut&result=${result}`),
    );
    assert.deepEqual(returned, { provider: "shortcut", result });
    assert.ok(returned);
    assert.deepEqual(connectionReturnCopy(returned), {
      tone: "success",
      message: result === "shortcut_connected" ? "Shortcut connected." : "Shortcut disconnected.",
    });
  },
);
