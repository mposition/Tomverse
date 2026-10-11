/**
 * Opaque proof that the server admitted the exact-deployment initial Auto
 * release. A plain object with the same fields is not authority: only objects
 * minted in this module are members of the private WeakSet.
 *
 * The release store is the sole production caller of the mint function. The
 * repository's authority import guard pins that edge; keeping the runtime
 * membership check here means request JSON and structural TypeScript casts
 * still cannot cross the boundary.
 */

import "server-only";

export const CHAT_REFINER_INITIAL_AUTO_ROUTER_BASIS =
  "chat_refiner_initial_auto_release" as const;

declare const chatRefinerInitialAutoRouterAuthorityBrand: unique symbol;

export type ChatRefinerInitialAutoRouterAuthority = Readonly<{
  basis: typeof CHAT_REFINER_INITIAL_AUTO_ROUTER_BASIS;
  routerActivationAuditLogId: string;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  readonly [chatRefinerInitialAutoRouterAuthorityBrand]: true;
}>;

export type ChatRefinerInitialAutoRouterAuthorityBinding = Readonly<{
  routerActivationAuditLogId: string;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
}>;

const mintedAuthorities = new WeakSet<object>();
const SHA = /^[0-9a-f]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Store-only mint after canonical audit and exact-runtime verification. */
export const mintChatRefinerInitialAutoRouterAuthority = (
  binding: ChatRefinerInitialAutoRouterAuthorityBinding
): ChatRefinerInitialAutoRouterAuthority => {
  if (
    !binding.routerActivationAuditLogId ||
    !SHA.test(binding.runtimeCommitSha) ||
    !UUID.test(binding.runtimeDeploymentId)
  ) {
    throw new Error("chat_refiner_initial_auto_router_authority_binding_invalid");
  }
  const authority = Object.freeze({
    basis: CHAT_REFINER_INITIAL_AUTO_ROUTER_BASIS,
    routerActivationAuditLogId: binding.routerActivationAuditLogId,
    runtimeCommitSha: binding.runtimeCommitSha,
    runtimeDeploymentId: binding.runtimeDeploymentId,
  }) as ChatRefinerInitialAutoRouterAuthority;
  mintedAuthorities.add(authority);
  return authority;
};

export const isChatRefinerInitialAutoRouterAuthority = (
  value: unknown
): value is ChatRefinerInitialAutoRouterAuthority =>
  typeof value === "object" && value !== null && mintedAuthorities.has(value);
