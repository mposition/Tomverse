/**
 * Unit test files that write into the repository's own working tree.
 *
 * The unit runner executes test files concurrently, one process per file, so
 * a file that creates, edits or deletes a path inside the checkout -- even one
 * it restores in a `finally` -- is visible to every other file running at the
 * same moment. A directory scan elsewhere in the suite then sees a probe file
 * that is not part of the repository, and fails or, worse, passes on the wrong
 * content. See the memory-eval digest incident recorded in
 * tests/unitTestSerialFiles.test.mjs.
 *
 * Files named here are left out of the concurrent pass and run afterwards, one
 * at a time, when nothing else is running. The right long-term fix for any of
 * them is to work on a temporary copy instead (as memoryEvalSucc7Adoption
 * does); once a file stops touching the tree, remove it from this list.
 *
 * Names are bare file names inside `tests/`. They are spliced into a glob, so
 * they must stay within the runner's GLOB_SAFE_NAME alphabet.
 */
export const SERIAL_UNIT_TEST_FILES = Object.freeze([
  // Writes apps/mobile/src/boundaryProbe.test-tmp.ts to exercise
  // scripts/check-native-token-boundary.mjs against real sources.
  "mobileAuthBridgeContract.test.mjs",
  // Runs scripts/new-staging-verification-record.mjs, which writes records
  // into docs/ops/mobile-auth-key-rotation-verification-records/.
  "stagingVerificationRecords.test.mjs",
]);
