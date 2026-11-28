-- Public, read-only share links for one previewed page
-- (docs/policy/generated-artifacts.md section 19). New table only; nothing
-- existing changes. Every relation cascades, so the link goes with the
-- account, conversation, answer or generated file it was made from.

-- CreateTable
CREATE TABLE "ArtifactShare" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "artifactId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "previewKind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactShare_token_key" ON "ArtifactShare"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactShare_sourceKey_key" ON "ArtifactShare"("sourceKey");

-- CreateIndex
CREATE INDEX "ArtifactShare_userId_createdAt_idx" ON "ArtifactShare"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ArtifactShare_conversationId_idx" ON "ArtifactShare"("conversationId");

-- CreateIndex
CREATE INDEX "ArtifactShare_messageId_idx" ON "ArtifactShare"("messageId");

-- CreateIndex
CREATE INDEX "ArtifactShare_artifactId_idx" ON "ArtifactShare"("artifactId");

-- AddForeignKey
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "MessageArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Closed lists, owned by lib/artifactShareAccess.ts (scripts/check-enum-constraints.mjs).
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_sourceKind_check" CHECK ("sourceKind" IN ('artifact', 'code_block'));
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_previewKind_check" CHECK ("previewKind" IN ('html', 'svg', 'react'));
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_language_check" CHECK ("language" IN ('html', 'htm', 'svg', 'jsx', 'tsx'));

-- A generated file's link names the file; a code block's does not.
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_source_shape_check" CHECK ((("sourceKind" = 'artifact') = ("artifactId" IS NOT NULL)));

-- The language is one the kind can be written in.
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_kind_language_check" CHECK ((("previewKind" = 'html' AND "language" IN ('html', 'htm')) OR ("previewKind" = 'svg' AND "language" = 'svg') OR ("previewKind" = 'react' AND "language" IN ('jsx', 'tsx'))));

-- The preview's own size limit (HTML_PREVIEW_MAX_BYTES), so a stored page can always be shown.
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_content_size_check" CHECK ((octet_length("content") BETWEEN 1 AND 1000000));

-- A link that never opens is not one.
ALTER TABLE "ArtifactShare" ADD CONSTRAINT "ArtifactShare_expiry_check" CHECK (("expiresAt" > "createdAt"));
