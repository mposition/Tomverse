import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import {
  ARTIFACT_SHARE_MAX_BLOCK_INDEX,
  artifactShareSourceKey,
  artifactShareTtlDays,
  shareableCodeLanguage,
} from "@/lib/artifactShareAccess";
import { findArtifactShare, prepareArtifactShare, publishArtifactShare, type ArtifactShareView } from "@/lib/artifactShareService";
import { isArtifactSharingEnabled } from "@/lib/artifactShareSettings";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { HTML_PREVIEW_MAX_BYTES } from "@/lib/htmlArtifactPreview";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * A signed-in owner's share links for previewed pages: whether one exists for
 * a source (GET) and making one (POST). Stopping one is ./[shareId].
 *
 * Policy: docs/policy/generated-artifacts.md section 19. The page that is
 * published is read on the server from the owner's own file or answer
 * (lib/artifactShareService.ts); the request names the source and nothing it
 * says becomes the page unless the stored answer contains it.
 */

const ID = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const BLOCK_INDEX = z.number().int().min(0).max(ARTIFACT_SHARE_MAX_BLOCK_INDEX);

const createSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("artifact"), artifactId: ID }).strict(),
      z.object({
        kind: z.literal("code_block"),
        messageId: ID,
        // The block's position among its answer's previewable blocks (previewableBlockIndex).
        blockIndex: BLOCK_INDEX,
        language: z.string().trim().min(1).max(16),
        code: z.string().min(1).max(HTML_PREVIEW_MAX_BYTES),
      }).strict(),
    ]),
  })
  .strict();

/** A megabyte of code is up to a little over two once JSON-escaped. */
const CREATE_BODY_MAX_BYTES = 2_200_000;

const signedInUser = async (req: Request) => {
  const authentication = await resolveChatRouteSession(req);
  if (authentication.response) return { response: authentication.response };
  const userId = authentication.session?.user?.id;
  if (!userId) return { response: NextResponse.json({ error: "Login required" }, { status: 401 }) };
  return { userId };
};

const shareUrl = (req: Request, share: ArtifactShareView) => `${getPublicAppOrigin(req)}/share/a/${share.token}`;

const publicView = (req: Request, share: ArtifactShareView) => ({
  id: share.id,
  url: shareUrl(req, share),
  createdAt: share.createdAt,
  expiresAt: share.expiresAt,
});

export async function GET(req: Request) {
  const user = await signedInUser(req);
  if ("response" in user) return user.response;
  try {
    await consumeApiRateLimit(req, user.userId, "artifact-share-status", { minute: 60, day: 2_000 });
    const params = new URL(req.url).searchParams;
    const artifactId = ID.safeParse(params.get("artifactId") ?? "");
    const messageId = ID.safeParse(params.get("messageId") ?? "");
    const blockIndex = BLOCK_INDEX.safeParse(/^\d{1,4}$/.test(params.get("blockIndex") ?? "") ? Number(params.get("blockIndex")) : -1);
    const language = shareableCodeLanguage(params.get("language"))?.language;
    const contentHash = /^[0-9a-f]{64}$/.exec(params.get("contentHash") ?? "")?.[0];
    // The same key the link was made under (lib/artifactShareService.ts prepareArtifactShare).
    const sourceKey = artifactId.success
      ? artifactShareSourceKey({ kind: "artifact", artifactId: artifactId.data })
      : messageId.success && blockIndex.success && language && contentHash
        ? artifactShareSourceKey({ kind: "code_block", messageId: messageId.data, blockIndex: blockIndex.data, language, contentHash })
        : null;
    if (!sourceKey) return NextResponse.json({ error: "Name a file or a code block.", code: "INVALID_REQUEST" }, { status: 400 });
    const enabled = await isArtifactSharingEnabled();
    // An existing link is shown even while sharing is off, so its owner can still stop it.
    const share = await findArtifactShare(user.userId, sourceKey);
    return NextResponse.json({
      enabled,
      ttlDays: artifactShareTtlDays(process.env),
      share: share ? publicView(req, share) : null,
    });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
  }
}

export async function POST(req: Request) {
  const user = await signedInUser(req);
  if ("response" in user) return user.response;
  const { userId } = user;
  try {
    await consumeApiRateLimit(req, userId, "artifact-share-create", { minute: 10, day: 100 });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (!security) throw error;
    logSecurityAuditEvent("artifact.share.create", { userId, request: req, outcome: "rate_limited" });
    return security;
  }

  let body: z.infer<typeof createSchema>;
  try {
    body = await readLimitedJson(req, CREATE_BODY_MAX_BYTES, createSchema);
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
  }

  const resourceId = body.source.kind === "artifact" ? body.source.artifactId : body.source.messageId;
  logSecurityAuditEvent("artifact.share.create", { userId, resourceId, request: req, outcome: "attempt" });
  const [sharingAvailable, plan] = await Promise.all([isArtifactSharingEnabled(), getUserBillingPlan(userId)]);
  const prepared = await prepareArtifactShare(userId, body.source, { sharingAvailable, planAllowsSharing: plan.allowSharing });
  if (!prepared.ok) {
    logSecurityAuditEvent("artifact.share.create", { userId, resourceId, request: req, outcome: "denied", reason: prepared.code });
    return NextResponse.json({ error: "This page cannot be shared.", code: prepared.code }, { status: prepared.status });
  }

  const published = await publishArtifactShare(userId, prepared.prepared);
  if (!published) {
    // The conversation was locked (or otherwise changed) between the check and the write.
    logSecurityAuditEvent("artifact.share.create", { userId, resourceId, request: req, outcome: "denied", reason: "CONVERSATION_LOCKED" });
    return NextResponse.json({ error: "This page cannot be shared.", code: "CONVERSATION_LOCKED" }, { status: 409 });
  }
  logSecurityAuditEvent("artifact.share.create", { userId, resourceId: published.share.id, request: req, outcome: "success" });
  return NextResponse.json({ created: published.created, share: publicView(req, published.share) });
}
