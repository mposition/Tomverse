import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidTemplatePlaceholders,
  renderSlackTemplate,
  SLACK_ALERT_MENTION,
  templatePlaceholders,
} from "../lib/slackMessageTemplateCore.ts";

test("uses a channel-wide mention for every Slack delivery", () => {
  assert.equal(SLACK_ALERT_MENTION, "<!channel>");
});

test("renders managed Slack template variables", () => {
  assert.equal(
    renderSlackTemplate("Railway {{status}} · {{cost}}", {
      status: "healthy",
      cost: "$12.34",
    }),
    "Railway healthy · $12.34"
  );
});

test("rejects placeholders outside the selected template contract", () => {
  assert.deepEqual(
    invalidTemplatePlaceholders(
      "provider_alert",
      "{{title}}",
      "{{provider}} {{unknownSecret}}"
    ),
    ["unknownSecret"]
  );
  assert.deepEqual(templatePlaceholders("{{title}} {{ detail }}"), [
    "title",
    "detail",
  ]);
});
