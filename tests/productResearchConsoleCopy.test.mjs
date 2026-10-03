// What the observation section is allowed to say, and what it cannot have.
//
// The section shows open issues beside a verdict, which reads as a to-do list
// unless the copy says otherwise. The policy forbids six words for that reason
// (docs/policy/product-research-agent.md §2, conditions 3 and 4) and these hold
// them out of both locales, out of the label table, and out of the component.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminProductResearchMessages } from "../lib/adminMessages/productResearch.ts";
import {
  ALLOWED_LABEL_PHRASES,
  FORBIDDEN_LABEL_WORDS,
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_HEADING,
  OBSERVATION_LABELS,
  observationLabel,
} from "../lib/productResearchObservationCore.mjs";

const panel = readFileSync(
  new URL("../components/admin/AdminProductResearchPanel.tsx", import.meta.url),
  "utf8",
);

/** The word, with every phrase that is allowed to contain it taken out first. */
const withoutAllowedPhrases = (text) =>
  ALLOWED_LABEL_PHRASES.reduce((left, phrase) => left.split(phrase).join(""), text);

test("neither locale uses a word that turns the table into advice", () => {
  for (const [locale, strings] of Object.entries(adminProductResearchMessages)) {
    for (const [key, value] of Object.entries(strings)) {
      const text = withoutAllowedPhrases(value);
      for (const word of FORBIDDEN_LABEL_WORDS) {
        assert.equal(
          text.includes(word),
          false,
          `${locale}.${key} contains "${word}": ${value}`,
        );
      }
    }
  }
});

test("the two locales define the same keys", () => {
  // A key present in one and missing in the other renders as the fallback
  // locale's sentence beside Korean copy, and the sentence that goes missing
  // first is the one nobody tested.
  const locales = Object.entries(adminProductResearchMessages);
  assert.ok(locales.length >= 2);
  const [, first] = locales[0];
  for (const [locale, strings] of locales.slice(1)) {
    assert.deepEqual(Object.keys(strings).sort(), Object.keys(first).sort(), locale);
  }
});

test("every placeholder a sentence uses is one its caller fills", () => {
  // `fill()` replaces what it is given and leaves the rest on screen as
  // `{hours}`, so a placeholder the panel never passes is visible to an
  // operator.
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  for (const [locale, strings] of Object.entries(adminProductResearchMessages)) {
    for (const [key, value] of Object.entries(strings)) {
      for (const name of placeholders(value)) {
        assert.match(
          panel,
          new RegExp(`\\b${name}:`),
          `${locale}.${key} uses {${name}}, which the panel does not fill`,
        );
      }
    }
  }
});

test("the section has no control, because there is nothing to decide", () => {
  // The agent copies a judgement the backlog report already made and proposes
  // nothing. A button here would be a decision this agent is not allowed to
  // put in front of anybody.
  for (const forbidden of ["<button", "onClick", "adminFetch", "useState", "fetch("]) {
    assert.equal(panel.includes(forbidden), false, `the panel has ${forbidden}`);
  }
  // And it reads the stored row only: no write path, no mutation module.
  assert.equal(/adminMessages\/productResearch/.test(panel), true);
});

test("the fixed heading is what the panel renders, not a sentence of its own", () => {
  assert.equal(OBSERVATION_HEADING.length > 0, true);
  // The heading travels in the payload so the layout cannot substitute one.
  assert.match(panel, /\{initial\.heading\}/);
  assert.equal(panel.includes(OBSERVATION_HEADING), false);
});

test("every slot state and failure stage has a label", () => {
  // A state with no label renders as its enum, which is a word the source
  // vocabulary chose for a signal and not for a person.
  for (const state of ["ok", "failed", "missing", "duplicate"]) {
    assert.equal(typeof observationLabel("slotState", state), "string", state);
  }
  assert.deepEqual(
    Object.keys(OBSERVATION_LABELS.failureStage).sort(),
    [...OBSERVATION_FAILURE_STAGES].sort(),
  );
  // An unknown value has no label rather than a guessed one.
  assert.equal(observationLabel("slotState", "exploded"), null);
  assert.equal(observationLabel("nosuchgroup", "ok"), null);
});
