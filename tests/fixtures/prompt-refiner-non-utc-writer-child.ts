import assert from "node:assert/strict";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  createPromptRefinerReservationStage,
  loadPromptRefinerStageAdmissionFacts,
} from "@/lib/promptRefinerStageAdmission";
import {
  buildPromptRefinerStagePreviewBinding,
  promptRefinerStagePreviewBindingDigest,
} from "@/lib/promptRefinerStageAdmissionCore";

const main = async () => {
  const [sessionClock] = await prisma.$queryRaw<Array<{ timeZone: string }>>`
    SELECT current_setting('TimeZone') AS "timeZone"
  `;
  assert.equal(sessionClock?.timeZone, "Australia/Brisbane");

  const facts = await loadPromptRefinerStageAdmissionFacts();
  const result = await createPromptRefinerReservationStage({
    session: {
      user: {
        id: "mposition",
        email: "owner@example.com",
        authenticatedAt: new Date().toISOString(),
      },
    } as Session,
    request: new Request(
      "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage",
      { method: "POST", headers: { "user-agent": "non-utc-db-integration" } }
    ),
    expected: {
      proposalDigest: facts.proposalDigest,
      runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
      executionManifestDigest: facts.executionManifestDigest,
      previewBindingDigest: promptRefinerStagePreviewBindingDigest(
        buildPromptRefinerStagePreviewBinding(facts)
      ),
    },
  });
  assert.equal(result.created, true);
  process.stdout.write(
    `${JSON.stringify({ timeZone: sessionClock.timeZone, stageId: result.stage.id })}\n`
  );
};

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
