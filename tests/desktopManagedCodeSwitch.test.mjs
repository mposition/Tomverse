import assert from "node:assert/strict";
import test from "node:test";

import { desktopManagedCodeEnabled } from "../lib/desktopManagedCodeSwitch.ts";
import { desktopWriteApiRoute } from "../lib/nativeBearerGate.ts";

const all = {
  TOMVERSE_DESKTOP_AUTH_ENABLED: "true",
  TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED: "true",
  TOMVERSE_DESKTOP_MANAGED_CODE_ENABLED: "true",
  CODE_MANAGED_EXECUTION_ENABLED: "true",
};

test("Desktop managed Code credits are off unless all four switches are exactly true", () => {
  assert.equal(desktopManagedCodeEnabled({}), false);
  assert.equal(desktopManagedCodeEnabled(all), true);
  for (const key of Object.keys(all)) {
    const rest = { ...all };
    delete rest[key];
    assert.equal(desktopManagedCodeEnabled(rest), false, `${key} missing`);
    assert.equal(desktopManagedCodeEnabled({ ...all, [key]: "1" }), false, `${key}=1`);
    assert.equal(desktopManagedCodeEnabled({ ...all, [key]: "TRUE" }), false, `${key}=TRUE`);
  }
});

test("the managed Code display switch enrols no Desktop bearer route", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, all);
    for (const method of ["GET", "POST"]) {
      assert.equal(desktopWriteApiRoute("/api/code/managed", method), false, method);
      assert.equal(desktopWriteApiRoute("/api/code/model-catalog", method), false, method);
    }
  } finally {
    for (const key of Object.keys(all)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
