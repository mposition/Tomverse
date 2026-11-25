import assert from "node:assert/strict";
import test from "node:test";
import { codeHistoryScope, matchesHistory } from "../src/host/history-scope";

const project = { path: "test-project", identity: "1:2" };
const key = "tvk_abcdefgh_test-fixture";
const endpoint = "https://tomverse.app/team/api/code/v1";
const scope = codeHistoryScope("profile", "first-account", project, { key, endpoint });

test("Code journal storage distinguishes accounts, project identities, full API bases and full keys", () => {
  assert.equal(codeHistoryScope("profile", "first-account", project, { key, endpoint: `${endpoint}/` }).home, scope.home);
  const otherScopes = [
    codeHistoryScope("profile", "second-account", project, { key, endpoint }),
    codeHistoryScope("profile", "first-account", { ...project, path: "another-project" }, { key, endpoint }),
    codeHistoryScope("profile", "first-account", { ...project, identity: "1:3" }, { key, endpoint }),
    codeHistoryScope("profile", "first-account", project, { key, endpoint: "https://tomverse.app/other/api/code/v1" }),
    codeHistoryScope("profile", "first-account", project, { key: `${key}-other`, endpoint }),
  ];
  assert.equal(new Set([scope.home, ...otherScopes.map(({ home }) => home)]).size, 6);
  assert.ok(!scope.home.includes(key));
});

test("old records require the original account folder, project, API base and verified key prefix", () => {
  const oldRecord = { workspace: { root: project.path }, endpointOrigin: scope.origin, endpointBase: scope.base, keyPrefix: scope.keyPrefix };
  assert.equal(matchesHistory(oldRecord, scope, scope.legacyHome), true);
  assert.equal(matchesHistory({ ...oldRecord, endpointBase: undefined }, scope, scope.legacyHome), true);
  assert.equal(matchesHistory({ ...oldRecord, endpointBase: undefined, keyIdentity: scope.keyIdentity }, scope, scope.home), false);
  assert.equal(matchesHistory(oldRecord, scope, scope.home), false);
  assert.equal(matchesHistory({ ...oldRecord, keyIdentity: scope.keyIdentity }, scope, scope.home), true);
  assert.equal(matchesHistory({ ...oldRecord, keyIdentity: "different-key" }, scope, scope.legacyHome), false);
  assert.equal(matchesHistory({ ...oldRecord, keyPrefix: "tvk_qrstuvwx" }, scope, scope.legacyHome), false);
  assert.equal(matchesHistory({ ...oldRecord, endpointBase: "https://tomverse.app/other/api/code/v1" }, scope, scope.legacyHome), false);
  const otherAccount = codeHistoryScope("profile", "second-account", project, { key, endpoint });
  assert.equal(matchesHistory(oldRecord, otherAccount, scope.legacyHome), false);
  const otherBase = codeHistoryScope("profile", "first-account", project, { key, endpoint: "https://tomverse.app/other/api/code/v1" });
  assert.equal(matchesHistory({ ...oldRecord, endpointBase: undefined }, otherBase, scope.legacyHome), false);
});
