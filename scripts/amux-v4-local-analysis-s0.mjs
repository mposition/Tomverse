/** Synthetic Ubuntu execution proof. No model CLI, provider endpoint, app DB,
 * private document, or operator idea is read or called by this script. */
import assert from "node:assert/strict";

import { prepareFirstIdeaOnlyAnalysisDraft } from "../lib/amux/ideaFirstAnalysisDraftCore.ts";
import { runAmuxV4SyntheticAnalysis } from "../lib/amux/ideaLocalSyntheticRunner.mjs";

const CHILD = String.raw`
const chunks = [];
process.stdin.on("data", (bytes) => chunks.push(bytes));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8");
  if (input !== "AMUX_V4_SYNTHETIC_INPUT" || process.env.DATABASE_URL ||
      process.env.GITHUB_TOKEN || process.env.SSH_AUTH_SOCK) process.exit(2);
  const refs = ["operator_idea"];
  const units = [
    { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
      title: "Synthetic initiative", description: "One bounded scope.", sourceRefIds: refs },
    { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
      title: "Synthetic epic", description: "One bounded scope.", sourceRefIds: refs },
    { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
      title: "Synthetic feature", description: "One bounded scope.", sourceRefIds: refs },
    { kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
      title: "Synthetic story", problem: "A bounded idea needs review.",
      scopeIn: ["Review one proposal"], scopeOut: ["No execution"],
      completionCriteria: ["One reviewable proposal exists"],
      featureRef: "c0:node-2", parentStoryRef: null,
      dependencyRefs: [], duplicateCandidateRefs: [], taskRole: null,
      executionGrade: null, executionBrief: null, sourceRefIds: refs },
  ];
  process.stdout.write(JSON.stringify({ schemaVersion: 2, previewId: "preview-01",
    chunkIndex: 0, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "The synthetic input was analyzed.", remainingScope: null, units }));
});
`;

async function main() {
  assert.equal(process.platform, "linux");
  assert.deepEqual(await runAmuxV4SyntheticAnalysis(["/usr/bin/claude"],
    Buffer.from("AMUX_V4_SYNTHETIC_INPUT")), { status: "refused" });
  assert.deepEqual(await runAmuxV4SyntheticAnalysis(["/usr/bin/node"],
    Buffer.alloc(65_537)), { status: "refused" });
  assert.deepEqual(await runAmuxV4SyntheticAnalysis(["/usr/bin/node", "-e",
    "process.stdout.write('X'.repeat(70000))"], Buffer.from("S0")),
  { status: "output_limit" });
  const input = Buffer.from("AMUX_V4_SYNTHETIC_INPUT", "utf8");
  const result = await runAmuxV4SyntheticAnalysis(["/usr/bin/node", "-e", CHILD], input);
  input.fill(0);
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  const keys = { masterKeyId: "s0-master", masterKeyVersion: 1,
    masterKey: Buffer.alloc(32, 3), digestKeyId: "s0-digest",
    digestKey: Buffer.alloc(32, 7) };
  try {
    const prepared = prepareFirstIdeaOnlyAnalysisDraft({
      ideaId: "idea-01", previewId: "preview-01",
      raw: result.output.toString("utf8"), keys,
    });
    assert.equal(prepared.decision, "ready");
    if (prepared.decision === "ready") {
      assert.equal(prepared.draft.units.length, 4);
      assert.equal(JSON.stringify(prepared).includes("Synthetic story"), false);
    }
    process.stdout.write("AMUX_V4_LOCAL_ANALYSIS_S0_PASS\n");
  } finally {
    result.output.fill(0);
    keys.masterKey.fill(0);
    keys.digestKey.fill(0);
  }
}
main().catch(() => { process.stderr.write("AMUX_V4_LOCAL_ANALYSIS_S0_FAIL\n"); process.exitCode = 1; });
