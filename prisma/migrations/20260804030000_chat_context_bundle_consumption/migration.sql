-- Context bundle consumption (docs/policy/external-conversation-import-and-memory.md §10).
--
-- Forward-only and additive, and it enables nothing on its own: injection
-- stays fail-closed behind `memoryInjectionEnabled`, which §12.4 keeps off
-- until the human eval procedure has been completed.
--
-- Why a table and not an in-process set: the nonce contract has to hold
-- across instances. A bundle replayed against a second server must be refused
-- there too, and nothing is shared between them but the database.
--
-- Why the unique index is the enforcement rather than a read-then-write: two
-- concurrent requests presenting the same (bundle, model) would both pass a
-- SELECT and both proceed. The INSERT is the check — one succeeds, the other
-- violates the constraint, and the loser is the replay.
--
-- Why the key is (bundle, model) and not the bundle: a comparison's three
-- model requests legitimately present one bundle, so a per-bundle single-use
-- rule would refuse two of its own panels.

CREATE TABLE "ChatContextBundleConsumption" (
    "id" TEXT NOT NULL,
    "consumptionKey" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatContextBundleConsumption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatContextBundleConsumption_consumptionKey_key"
    ON "ChatContextBundleConsumption"("consumptionKey");

-- Cleanup reads this: a row outlives its usefulness the moment the bundle it
-- names expires, and the table would otherwise grow with every chat request.
CREATE INDEX "ChatContextBundleConsumption_expiresAt_idx"
    ON "ChatContextBundleConsumption"("expiresAt");

-- Per-account diagnostics ("did this user's requests replay bundles"),
-- content-free (§22).
CREATE INDEX "ChatContextBundleConsumption_userId_createdAt_idx"
    ON "ChatContextBundleConsumption"("userId", "createdAt");
