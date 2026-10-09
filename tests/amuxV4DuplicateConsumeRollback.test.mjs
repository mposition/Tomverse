import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cases = [
  ["ideaStoryRegistrationService.ts", "AmuxCardDuplicateScanError"],
  ["ideaCardLinkService.ts", "AmuxCardDuplicateScanError"],
  ["ideaNodeRegistrationService.ts", "AmuxNodeDuplicateScanError"],
  ["ideaNodeSelectionService.ts", "AmuxNodeDuplicateScanError"],
];

test("a duplicate-scan rollback never freezes a prepared decision as outcome_unknown", () => {
  for (const [filename, errorClass] of cases) {
    const source = readFileSync(new URL(`../lib/amux/${filename}`, import.meta.url), "utf8");
    const branches = [...source.matchAll(new RegExp(
      `if \\(!callbackReturned && error instanceof ${errorClass}\\) \\{`, "g"))];
    assert.equal(branches.length, 2, `${filename}: prepare and consume classify known rollback`);
    const consume = source.slice(source.indexOf("export async function consumeAmuxV4"));
    const classifiedAt = consume.indexOf(`error instanceof ${errorClass}`);
    const frozenAt = consume.indexOf("await markAmuxV4UnitConsumeOutcomeUnknown");
    assert.ok(classifiedAt >= 0 && frozenAt > classifiedAt, filename);
    assert.match(consume.slice(classifiedAt, frozenAt),
      /"integrity_unavailable"\s*:\s*"reconfirm"/);
  }
});
