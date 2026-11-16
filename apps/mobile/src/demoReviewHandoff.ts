import type { ChatTransport, Conversation, ReviewHandoffDraft, ReviewHandoffResult } from "./chatTransport";

type DemoConversation = Conversation & { demoHandoffParent?: string };
/** Local test fixture only. Its draft store stands in for the authenticated server. */
export function createDemoReviewHandoff(key: string, read: () => DemoConversation[], write: (rows: DemoConversation[]) => void) {
  const attempts = (): Record<string, ReviewHandoffResult & { parentId: string; assistantId: string }> => JSON.parse(localStorage.getItem(`${key}:handoffs`) ?? "{}");
  const drafts = (): Record<string, ReviewHandoffDraft> => JSON.parse(localStorage.getItem(`${key}:handoff-drafts`) ?? "{}");
  const saveDrafts = (rows: Record<string, ReviewHandoffDraft>) => localStorage.setItem(`${key}:handoff-drafts`, JSON.stringify(rows));
  const fail = (code: string, status = 409): never => { throw Object.assign(Error(code), { code, status }); };
  const requireTarget = (id: string) => {
    const target = read().find(row => row.id === id);
    const parent = read().find(row => row.id === target?.demoHandoffParent);
    if (!target?.reviewHandoff || !parent || parent.imported?.status !== "available") fail("REVIEW_HANDOFF_UNAVAILABLE");
    return target;
  };
  const draft: NonNullable<ChatTransport["reviewHandoffDraft"]> = {
    get: async id => { requireTarget(id); return { scopeKey: id, draft: drafts()[id] ?? null }; },
    put: async (id, input) => {
      requireTarget(id); const rows = drafts();
      if ((rows[id]?.revision ?? 0) !== input.expectedRevision) fail("CHAT_DRAFT_REVISION_CONFLICT");
      rows[id] = { scopeKey: id, text: input.text, revision: input.expectedRevision + 1, attachmentReferences: [] };
      saveDrafts(rows); return { scopeKey: id, draft: rows[id] };
    },
    remove: async (id, expectedRevision) => {
      requireTarget(id); const rows = drafts();
      if (rows[id]?.revision !== expectedRevision) fail("CHAT_DRAFT_REVISION_CONFLICT");
      delete rows[id]; saveDrafts(rows); return { scopeKey: id, draft: null };
    },
  };
  const prepare: NonNullable<ChatTransport["prepareReviewHandoff"]> = async (id, input) => {
    const rows = attempts();
    const replay = rows[input.idempotencyKey];
    if (replay && (replay.parentId !== id || replay.assistantId !== input.assistantMessageId)) fail("REVIEW_HANDOFF_IDEMPOTENCY_CONFLICT");
    if (replay) return { ...replay, idempotentReplay: true };
    const parent = read().find(row => row.id === id);
    const anchor = parent?.messages.findIndex(message => message.id === input.assistantMessageId && message.role === "assistant") ?? -1;
    const questionIndex = parent?.messages.reduce((latest, message, index) => index < anchor && message.role === "user" ? index : latest, -1) ?? -1;
    if (!parent || parent.surface !== "continuation" || parent.imported?.status !== "available" || anchor < 0 || questionIndex < 0) fail("REVIEW_HANDOFF_UNAVAILABLE");
    const source = parent!;
    if (source.messages[questionIndex].content.length > 50_000) fail("REVIEW_HANDOFF_QUESTION_TOO_LONG", 413);
    if (source.messages[anchor].researchRunId || source.messages[anchor].imageTurn) fail("REVIEW_HANDOFF_MODE_UNSUPPORTED");
    if (source.messages.slice(0, questionIndex + 1).some(message => message.attachments?.length) || source.messages[anchor].imageTurn) fail("REVIEW_HANDOFF_ATTACHMENTS_UNSUPPORTED");
    const conversationId = crypto.randomUUID();
    const reviewHandoff = { sourceMode: "legacy" as const, sourceTurnCount: source.imported!.messages.length, nativeTurnCount: questionIndex, nativeOmittedCount: 0, sourceOmittedCount: 0, attachmentsSupported: false as const };
    const result = { conversationId, route: `/continuations/${conversationId}`, idempotentReplay: false, reviewHandoff };
    write([{ id: conversationId, title: "Review of Chat question", surface: "continuation", productKey: "review", selectionMode: "manual", selectedModels: [], messages: [], reviewHandoff, demoHandoffParent: id }, ...read()]);
    const savedDrafts = drafts();
    savedDrafts[conversationId] = { scopeKey: conversationId, text: source.messages[questionIndex].content, revision: 1, attachmentReferences: [] };
    saveDrafts(savedDrafts);
    rows[input.idempotencyKey] = { ...result, parentId: id, assistantId: input.assistantMessageId };
    localStorage.setItem(`${key}:handoffs`, JSON.stringify(rows));
    const failures: string[] = JSON.parse(localStorage.getItem(`${key}:handoff-fail-once`) ?? "[]");
    if (failures.includes(input.assistantMessageId)) {
      localStorage.setItem(`${key}:handoff-fail-once`, JSON.stringify(failures.filter(value => value !== input.assistantMessageId)));
      throw Error("Synthetic lost acknowledgement");
    }
    return result;
  };
  return { prepare, draft, consume: async (id: string, text: string, revision: number) => {
    const row = drafts()[id];
    if (!row || row.text !== text || row.revision !== revision) fail("CHAT_DRAFT_REVISION_CONFLICT");
    await draft.remove(id, revision);
  }, imported: (target: DemoConversation) => target.demoHandoffParent ? read().find(row => row.id === target.demoHandoffParent)?.imported : target.imported };
}
