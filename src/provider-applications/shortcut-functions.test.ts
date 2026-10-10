import assert from "node:assert/strict";
import { it } from "vitest";
import { configurationSchema } from "./functions.js";

it("accepts native Shortcut configuration through the browser save contract", () => {
  const input = {
    provider: "shortcut",
    apiToken: "private-test-token",
    webhookSecret: "private-test-secret",
    expectedVersion: 2,
    surface: "apps",
  };
  assert.deepEqual(configurationSchema.parse(input), input);
});
