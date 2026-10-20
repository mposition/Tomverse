/**
 * Sending one Scout suggestion to AMUX (docs/policy/product-research-agent.md
 * §10), as a decision over its dependencies so every path is testable.
 *
 * The request id is derived from the suggestion, so the read-back finds an
 * earlier send of this suggestion whoever started it: a send whose idea was
 * made but whose suggestion was never closed -- the process stopped between
 * the two -- is finished by the next send, by any owner, without a second
 * idea. A concurrent send that loses AMUX's request-id race reads the
 * winner's idea back.
 */
export type ScoutSendReadBack =
  | { readonly status: "absent" }
  | { readonly status: "partial"; readonly ideaId: string }
  | { readonly status: "committed"; readonly ideaId: string };

export type ScoutSendDeps = {
  /** The AMUX submission for this suggestion's request id, by any owner. */
  readonly readBack: () => Promise<ScoutSendReadBack>;
  readonly submit: () => Promise<{ readonly ideaId: string }>;
  /** Whether a submit failure is AMUX refusing a request id it already holds. */
  readonly isAlreadySeen: (error: unknown) => boolean;
  /** Marks the suggestion sent; false when it was no longer open. */
  readonly close: (ideaId: string) => Promise<boolean>;
};

export type ScoutSendResult =
  | { readonly kind: "sent"; readonly ideaId: string; readonly closed: boolean }
  | { readonly kind: "partial"; readonly ideaId: string }
  | { readonly kind: "in_progress" };

export async function sendScoutSuggestion(deps: ScoutSendDeps): Promise<ScoutSendResult> {
  const earlier = await deps.readBack();
  let ideaId: string;
  if (earlier.status === "committed") {
    ideaId = earlier.ideaId;
  } else if (earlier.status === "partial") {
    return { kind: "partial", ideaId: earlier.ideaId };
  } else {
    try {
      ideaId = (await deps.submit()).ideaId;
    } catch (error) {
      if (!deps.isAlreadySeen(error)) throw error;
      const winner = await deps.readBack();
      if (winner.status === "committed") ideaId = winner.ideaId;
      else if (winner.status === "partial") return { kind: "partial", ideaId: winner.ideaId };
      else return { kind: "in_progress" };
    }
  }
  return { kind: "sent", ideaId, closed: await deps.close(ideaId) };
}
