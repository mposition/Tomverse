/** Prepare independent inputs together. Neither job may consume the question or dispatch a model. */
export async function prepareChatSendInputs<D>(input: {
  context: () => Promise<string | null>;
  draft: () => Promise<D | null>;
  isCurrent: () => boolean;
  abortDraft: (draft: D) => void;
}) {
  // Wait for both even on failure so a late prepared draft cannot remain frozen.
  const [context, draft] = await Promise.allSettled([input.context(), input.draft()]);
  const preparedDraft = draft.status === "fulfilled" ? draft.value : null;
  if (context.status === "rejected" || draft.status === "rejected") {
    if (preparedDraft !== null) input.abortDraft(preparedDraft);
    throw context.status === "rejected" ? context.reason : (draft as PromiseRejectedResult).reason;
  }
  if (!input.isCurrent()) {
    if (preparedDraft !== null) input.abortDraft(preparedDraft);
    return null;
  }
  return { contextBundle: context.value, preparedDraft };
}
