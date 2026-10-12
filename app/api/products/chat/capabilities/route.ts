export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { autoSelectionCapability } from "@/lib/autoRoutingUi";
import { identifyChatCaller } from "@/lib/chatSecurity";
import {
  mintGuestChatAutoAuthority,
} from "@/lib/guestChatAutoAuthority";
import {
  GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV,
  guestChatSmartAdaptiveAuthorityTtlSeconds,
} from "@/lib/guestChatSmartAdaptiveRelease";
import { readGuestChatSmartAdaptiveRelease } from
  "@/lib/guestChatSmartAdaptiveReleaseStore";
import { promptRefinerChatExecutionRelease } from
  "@/lib/promptRefinerChatExecutionRelease";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Read the server-owned Auto capability for a not-yet-created Tomverse Chat.
 *
 * This is deliberately read-only. Merely opening the workspace must not
 * consume conversation capacity or leave an empty row behind. The product is
 * this route's constant and the response exposes only the same boolean that a
 * confirmed Chat conversation detail exposes; rollout reasons stay server
 * side.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    const access = identifyChatCaller(request, null);
    try {
      const [guestRelease, refinerRelease] = await Promise.all([
        readGuestChatSmartAdaptiveRelease(),
        promptRefinerChatExecutionRelease(),
      ]);
      if (!guestRelease || !refinerRelease.autoEnabled ||
          refinerRelease.runtimeCommitSha !==
            guestRelease.binding.runtimeCommitSha ||
          refinerRelease.runtimeDeploymentId !==
            guestRelease.binding.runtimeDeploymentId) {
        const response = NextResponse.json(
          {
            autoSelection: { offered: false },
            guestAuto: { attachmentSupport: "manual_only" },
          },
          { headers: NO_STORE_HEADERS });
        if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
        return response;
      }
      const token = mintGuestChatAutoAuthority({
        secret: process.env[GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV] ?? "",
        binding: {
          subjectKey: access.subjectKey as `guest:${string}`,
          sourceCommitSha: guestRelease.binding.runtimeCommitSha,
          runtimeDeploymentId: guestRelease.binding.runtimeDeploymentId,
          activationPairDigest: guestRelease.activationPairDigest,
          configDigest: guestRelease.binding.configDigest,
        },
        authorityId: randomUUID(),
        nonce: randomUUID(),
        nowMs: Date.now(),
        ttlSeconds: guestChatSmartAdaptiveAuthorityTtlSeconds(),
      });
      const response = NextResponse.json({
        autoSelection: { offered: true },
        guestAutoAuthority: token,
        guestAuto: { attachmentSupport: "manual_only" },
      }, { headers: NO_STORE_HEADERS });
      if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
      return response;
    } catch (error) {
      console.error(JSON.stringify({
        event: "guest_chat_auto_capability_unavailable",
        errorName: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }));
      const response = NextResponse.json(
        {
          autoSelection: { offered: false },
          guestAuto: { attachmentSupport: "manual_only" },
        },
        { headers: NO_STORE_HEADERS });
      if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
      return response;
    }
  }

  try {
    const availability = await autoAvailabilityFor(session.user.id);
    return NextResponse.json(
      { autoSelection: autoSelectionCapability(availability) },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "chat_draft_auto_capability_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }));
    return NextResponse.json(
      { autoSelection: { offered: false } },
      { headers: NO_STORE_HEADERS }
    );
  }
}
