import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PRODUCT_ANALYTICS_EVENT_NAMES,
  analyticsPropertiesSchema,
} from "../lib/productAnalyticsShared.ts";
import { IMAGE_INTENT_CLASSES } from "../lib/imageIntentSignals.ts";

/**
 * The handoff chip's telemetry answers three questions -- was it offered, was
 * it right, was it in the way -- and carries nothing else.
 *
 * The draft it was derived from is the user's prompt. The guarantee that it
 * cannot travel is structural: `analyticsPropertiesSchema` is a closed object,
 * so a key it does not name is stripped before the event leaves the browser.
 */

const CHIP_EVENTS = [
  "image_intent_suggestion_shown",
  "image_intent_suggestion_accepted",
  "image_intent_suggestion_dismissed",
];

test("the three chip events are registered", () => {
  for (const name of CHIP_EVENTS) {
    assert.ok(
      PRODUCT_ANALYTICS_EVENT_NAMES.includes(name),
      `${name} is missing from the event allowlist`
    );
  }
});

test("the intent property is the classifier's closed enum and nothing wider", () => {
  for (const value of IMAGE_INTENT_CLASSES) {
    const parsed = analyticsPropertiesSchema.safeParse({ image_intent_class: value });
    assert.equal(parsed.success, true, value);
  }
  for (const value of ["draw a cat", "raster", "", 1, null]) {
    const parsed = analyticsPropertiesSchema.safeParse({ image_intent_class: value });
    assert.equal(parsed.success, false, String(value));
  }
});

test("the lock property says what the requirement was, never who the viewer is", () => {
  for (const value of ["none", "sign_in", "upgrade"]) {
    assert.equal(
      analyticsPropertiesSchema.safeParse({ image_intent_lock: value }).success,
      true,
      value
    );
  }
  for (const value of ["user@example.com", "Pro", "guest_1234"]) {
    assert.equal(
      analyticsPropertiesSchema.safeParse({ image_intent_lock: value }).success,
      false,
      value
    );
  }
});

test("a key a draft or a filename could travel in stops the event entirely", () => {
  // The schema is `.strict()`, so an unknown key is a parse failure rather
  // than a silent strip -- and `trackProductEvent` drops the event when the
  // parse fails. Either way the prose never leaves the browser; this pins
  // which of the two it is.
  const parsed = analyticsPropertiesSchema.safeParse({
    image_intent_class: "raster_generation",
    prompt: "draw a picture of my house at 12 Example Street",
    draft: "draw a picture",
    attachment_name: "passport.png",
    file_id: "upl_123",
  });
  assert.equal(parsed.success, false);
  assert.equal(
    analyticsPropertiesSchema.safeParse({
      image_intent_class: "raster_generation",
      image_intent_lock: "none",
    }).success,
    true
  );
});

test("the surface property names the moment, and cannot widen into anything else", () => {
  // Added when the offer grew a second moment. A closed enum for the same
  // reason as the class above: "which surface" is a product question with two
  // answers, and a free string is where a draft eventually gets put.
  for (const value of ["composer", "after_answer"]) {
    assert.equal(
      analyticsPropertiesSchema.safeParse({ image_intent_surface: value }).success,
      true,
      value
    );
  }
  for (const value of ["", "chat", "answer", "draw a picture of my house"]) {
    assert.equal(
      analyticsPropertiesSchema.safeParse({ image_intent_surface: value }).success,
      false,
      value
    );
  }
});

test("the composer sends only the three allowed properties with these events", () => {
  const source = readFileSync("components/chat/ChatInput.tsx", "utf8");
  for (const event of CHIP_EVENTS) {
    const at = source.indexOf(event);
    assert.ok(at > 0, event);
  }
  // The call sites' property objects, read from the source: a future edit that
  // adds `value` or an attachment name to them fails here rather than in
  // review.
  const calls = source.match(
    /trackProductEvent\([\s\S]{0,400}?image_intent_class[\s\S]{0,200}?\}\s*\);/g
  );
  assert.ok(calls && calls.length >= 2, "chip events must go through trackProductEvent");
  for (const call of calls) {
    // Only the property object, so the event name (which also contains
    // "image_intent") is not mistaken for a property.
    const properties = call.slice(call.indexOf("{")).match(/^\s*([a-z_]+):/gm) ?? [];
    for (const property of properties) {
      const name = property.trim().replace(":", "");
      assert.ok(
        [
          "image_intent_class",
          "image_intent_lock",
          "image_intent_surface",
        ].includes(name),
        `unexpected property ${name}`
      );
    }
    assert.equal(/\bvalue\b|\bprompt\b|\bdraft\b|attachment/.test(call), false, call);
  }
});

test("the chip uses the shared consent-gated path and no delivery of its own", () => {
  // The chip adds no transport. It calls `trackProductEvent`, whose queue is
  // gated on the stored decision, so a declined visitor queues nothing.
  const client = readFileSync("lib/productAnalyticsClient.ts", "utf8");
  const queue = client.slice(client.indexOf("const queuePendingIntent"));
  assert.ok(queue.slice(0, queue.indexOf("\n};")).includes('analyticsConsent() === "declined"'));

  const composer = readFileSync("components/chat/ChatInput.tsx", "utf8");
  const chipRegion = composer.slice(
    composer.indexOf("image_intent_suggestion_shown") - 600,
    composer.indexOf("image_intent_suggestion_dismissed") + 600
  );
  for (const transport of ["fetch(", "sendBeacon", "XMLHttpRequest", "gtag("]) {
    assert.equal(chipRegion.includes(transport), false, transport);
  }
});
