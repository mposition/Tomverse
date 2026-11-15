import { strict as assert } from "node:assert";
import test from "node:test";

import {
  coveredByAnotherModal,
  registerOpenModal,
} from "../components/useModalDialog.ts";

/**
 * Which open modal owns Tab and Escape. Plain objects stand in for the dialog
 * elements: the decision only compares identities, and the unit runner has no
 * DOM.
 */

test("the model finder owns its keys while the mobile drawer is mounted after it", () => {
  const finder = { name: "finder" };
  const drawer = { name: "drawer" };
  // The drawer opened first and renders later in the document.
  const releaseDrawer = registerOpenModal(drawer);
  const releaseFinder = registerOpenModal(finder);
  try {
    const documentOrder = [finder, drawer];
    assert.equal(coveredByAnotherModal(finder, documentOrder), false);
    assert.equal(coveredByAnotherModal(drawer, documentOrder), true);
  } finally {
    releaseFinder();
    releaseDrawer();
  }
});

test("a dialog underneath stays covered when the one on top renders before it", () => {
  const settings = { name: "settings" };
  const confirm = { name: "confirm" };
  const releaseSettings = registerOpenModal(settings);
  const releaseConfirm = registerOpenModal(confirm);
  try {
    const documentOrder = [confirm, settings];
    assert.equal(coveredByAnotherModal(settings, documentOrder), true);
    assert.equal(coveredByAnotherModal(confirm, documentOrder), false);
  } finally {
    releaseConfirm();
    releaseSettings();
  }
});

test("a later dialog that does not register still covers by document order", () => {
  const finder = { name: "finder" };
  const unregistered = { name: "legacy" };
  const releaseFinder = registerOpenModal(finder);
  try {
    assert.equal(coveredByAnotherModal(finder, [finder, unregistered]), true);
    assert.equal(coveredByAnotherModal(finder, [unregistered, finder]), false);
  } finally {
    releaseFinder();
  }
});

test("a lone or unmounted dialog is not covered", () => {
  const finder = { name: "finder" };
  const releaseFinder = registerOpenModal(finder);
  try {
    assert.equal(coveredByAnotherModal(finder, [finder]), false);
    assert.equal(coveredByAnotherModal(null, [finder]), false);
  } finally {
    releaseFinder();
  }
});
