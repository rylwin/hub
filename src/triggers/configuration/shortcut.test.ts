import assert from "node:assert/strict";
import { it } from "vitest";
import { isEditorEvent, eventDefinition } from "./events.js";

it("offers only Shortcut's new-comment mention event in the trigger editor", () => {
  assert.equal(isEditorEvent("shortcut.mention"), true);
  assert.equal(eventDefinition("shortcut.mention").provider, "shortcut");
  assert.equal(isEditorEvent("shortcut.story_state_changed"), false);
  assert.equal(isEditorEvent("shortcut.comment_updated"), false);
});
