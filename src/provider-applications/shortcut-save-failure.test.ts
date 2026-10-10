import assert from "node:assert/strict";
import { it } from "vitest";
import { ProviderApplicationError } from "./index.js";
import { providerApplicationSaveFailure, providerHost, providerName } from "./save-failure.js";

it("names Shortcut and its fixed API host in setup diagnostics", () => {
  assert.equal(providerName("shortcut"), "Shortcut");
  assert.equal(providerHost("shortcut"), "api.app.shortcut.com");
});

it("explains a rejected Shortcut token without claiming an OAuth application failed", () => {
  const result = providerApplicationSaveFailure(
    "shortcut",
    new ProviderApplicationError("credentialsRejected"),
  );
  assert.equal(
    result.error.message,
    "Shortcut rejected the API token. Nothing was saved. Create a token for the dedicated bot account with Read and Create Story Comments permissions, then verify again.",
  );
});
