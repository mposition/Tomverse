import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_ANALYTICS_EVENT_NAMES,
  analyticsPropertiesSchema,
} from "../lib/productAnalyticsShared.ts";

/**
 * The image-intent suggestion events are retired: the rule-based handoff chip
 * was removed 2026-10-20 in favour of the LLM judgement
 * (lib/chatImageIntent.ts). The event names and properties stay in the schema
 * because the database CHECK constraint still lists them
 * (prisma/migrations/20260824120000_image_intent_handoff_analytics_events).
 *
 * What is pinned here is the privacy guarantee those properties carry: the
 * prompt a suggestion was derived from cannot travel. The guarantee is
 * structural -- `analyticsPropertiesSchema` is a closed object, so a key it
 * does not name stops the event before it leaves the browser.
 */

// The closed class enum of the analytics schema, restated here because the
// classifier that used to export it no longer exists.
const IMAGE_INTENT_CLASSES = [
  "raster_generation",
  "text_heavy_visual",
  "edit_or_reference",
  "analysis",
  "explicit_text_art",
  "none",
];

const CHIP_EVENTS = [
  "image_intent_suggestion_shown",
  "image_intent_suggestion_accepted",
  "image_intent_suggestion_dismissed",
];

test("the three retired suggestion events stay registered", () => {
  for (const name of CHIP_EVENTS) {
    assert.ok(
      PRODUCT_ANALYTICS_EVENT_NAMES.includes(name),
      `${name} is missing from the event allowlist`
    );
  }
});

test("the intent property is a closed enum and nothing wider", () => {
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
