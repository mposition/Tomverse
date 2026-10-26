import assert from "node:assert/strict";
import test from "node:test";

import { tokenRefusal } from "../lib/ciAdmissionGithub.ts";

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
