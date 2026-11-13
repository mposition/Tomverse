import assert from "node:assert/strict";
import test from "node:test";

import { groupImageModelsByOwner } from "../../components/chat/ImageModelTabPanel";

const model = (id: string, provider: string, modelOwner?: string) =>
  ({ id, provider, ...(modelOwner ? { modelOwner } : {}) }) as unknown as Parameters<
    typeof groupImageModelsByOwner
  >[0][number];

test("image models group by owner, OpenAI then Google first, catalogue order within a group", () => {
  const groups = groupImageModelsByOwner([
    model("nano-banana-2", "fal", "google"),
    model("grok", "xai"),
    model("flash-lite", "google"),
    model("qwen-3", "qwen"),
    model("gpt-flare", "openai"),
    model("nano-banana-2.1", "google"),
    model("gpt-sunburst", "openai"),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.owner, group.models.map((entry) => entry.id)]),
    [
      ["openai", ["gpt-flare", "gpt-sunburst"]],
      // fal supplies Nano Banana 2, but it is Google's model.
      ["google", ["nano-banana-2", "flash-lite", "nano-banana-2.1"]],
      ["xai", ["grok"]],
      ["qwen", ["qwen-3"]],
    ]
  );
  assert.deepEqual(groupImageModelsByOwner([]), []);
});
