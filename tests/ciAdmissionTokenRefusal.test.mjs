import assert from "node:assert/strict";
import test from "node:test";

import { tokenRefusal, updateBranchRefusal } from "../lib/ciAdmissionGithub.ts";

test("a refused branch update says why: a ruleset, a workflow file, a moved head, a conflict", () => {
  const refused = (message) => updateBranchRefusal(422, () => ({ message }));
  // 2026-10-26: "qa-release-lane: no updates outside develop" refused #3041's update.
  assert.equal(refused("Repository rule violations found\n\nCannot update this protected ref."), "github_update_branch_ruleset");
  assert.equal(refused("refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"), "github_update_branch_workflows");
  assert.equal(refused("expected head sha didn't match current head ref."), "github_update_branch_head_moved");
  assert.equal(refused("merge conflict between base and head"), "github_update_branch_conflict");
  assert.equal(updateBranchRefusal(403, () => null), "github_update_branch_403");
});

test("a refused installation token says why in a short code, never in GitHub's words", () => {
  assert.equal(
    tokenRefusal(422, () => ({ message: "The permissions requested are not granted to this installation.", documentation_url: "x" })),
    "github_token_permission_not_granted",
  );
  assert.equal(
    tokenRefusal(422, () => ({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." })),
    "github_token_repository_not_installed",
  );
  assert.equal(tokenRefusal(422, () => ({ message: "Validation Failed" })), "github_token_422");
  assert.equal(
    tokenRefusal(500, () => {
      throw new Error("not json");
    }),
    "github_token_500",
  );
});
