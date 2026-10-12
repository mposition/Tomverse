import assert from "node:assert/strict";
import test from "node:test";

import { guestAutoClientExecutionState } from "../lib/guestAutoClientExecution.ts";

test("a restored Guest Chat Auto intent waits for exact server capability", () => {
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "auto",
      offered: false,
      hasCapability: false,
    }),
    "awaiting_capability"
  );
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "auto",
      offered: true,
      hasCapability: false,
    }),
    "awaiting_capability"
  );
});

test("Guest Chat Auto becomes ready only when offered and authority agree", () => {
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "auto",
      offered: true,
      hasCapability: true,
    }),
    "auto_ready"
  );
});

test("manual remains an explicit exit while capability refresh is pending", () => {
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "manual",
      offered: false,
      hasCapability: false,
    }),
    "manual"
  );
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "auto",
      offered: false,
      hasCapability: false,
    }),
    "awaiting_capability"
  );
});

test("OFF and ON can reuse a still-bound capability without a false pending state", () => {
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "manual",
      offered: true,
      hasCapability: true,
    }),
    "manual"
  );
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "auto",
      offered: true,
      hasCapability: true,
    }),
    "auto_ready"
  );
});

test("manual Guest Chat and Review never inherit the Auto capability barrier", () => {
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "chat",
      selectionMode: "manual",
      offered: false,
      hasCapability: false,
    }),
    "manual"
  );
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: true,
      surface: "review",
      selectionMode: "auto",
      offered: false,
      hasCapability: false,
    }),
    "manual"
  );
  assert.equal(
    guestAutoClientExecutionState({
      isGuestMode: false,
      surface: "chat",
      selectionMode: "auto",
      offered: false,
      hasCapability: false,
    }),
    "manual"
  );
});
