import "server-only";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { chatSurfaceAvailable } from "@/lib/autoProductBoundary";

/**
 * This source still requires an authenticated Chat workspace entry. The
 * product release that admits blank Guest Chat changes this public constant.
 * Marketing reads no session or account rollout while building static HTML.
 */
export const PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE = false;

/**
 * Whether the visitor asking for this page may start a Tomverse Chat.
 *
 * Server-only, and the only place the landing pages ask. A guest is never
 * eligible -- the cohort excludes guests, and there is no account to place in
 * one -- so an anonymous request costs nothing beyond the session read the
 * page already needs.
 *
 * A failure answers false. The refusal path is the Review workspace, which is
 * where everybody goes today anyway, so failing closed costs a visitor
 * nothing and failing open would send them somewhere they get bounced from.
 */
export const landingChatSurfaceAvailable = async (): Promise<{
  chatSurfaceAvailable: boolean;
  isAuthenticated: boolean;
}> => {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return { chatSurfaceAvailable: false, isAuthenticated: false };

    const availability = await autoAvailabilityFor(userId);
    return {
      chatSurfaceAvailable: chatSurfaceAvailable(availability),
      isAuthenticated: true,
    };
  } catch (error) {
    console.error("Failed to resolve the landing workspace destination:", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { chatSurfaceAvailable: false, isAuthenticated: false };
  }
};
