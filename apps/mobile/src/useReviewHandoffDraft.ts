import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatTransport, ReviewHandoffDraftEnvelope } from "./chatTransport";

type DraftState = {
  scope: string;
  text: string;
  savedText: string;
  revision: number;
  status: "loading" | "ready" | "saving" | "failed" | "conflict";
};

/** Only a handoff target uses this server draft; reference bodies never enter storage. */
export function useReviewHandoffDraft(owner: string | null, id: string | null, transport: ChatTransport) {
  const scope = JSON.stringify([owner, id]);
  const [state, setState] = useState<DraftState>({ scope, text: "", savedText: "", revision: 0, status: "loading" });
  const stateRef = useRef(state);
  const generation = useRef(0);
  useLayoutEffect(() => {
    const epoch = ++generation.current;
    stateRef.current = { scope, text: "", savedText: "", revision: 0, status: "loading" };
    return () => { generation.current = epoch + 1; };
  }, [scope, transport]);
  const update = useCallback((next: DraftState) => { stateRef.current = next; setState(next); }, []);
  const pending = useRef<{ generation: number; promise: Promise<number> } | null>(null);
  const validate = useCallback((reply: ReviewHandoffDraftEnvelope) => {
    if (reply.scopeKey !== id || (reply.draft && (reply.draft.scopeKey !== id || typeof reply.draft.text !== "string" || !Number.isInteger(reply.draft.revision) || reply.draft.revision < 1 || reply.draft.attachmentReferences.length))) {
      throw Error("REVIEW_HANDOFF_DRAFT_INVALID");
    }
    return reply.draft;
  }, [id]);
  const reload = useCallback(async () => {
    if (!owner || !id || !transport.reviewHandoffDraft) return;
    const epoch = generation.current;
    update({ ...stateRef.current, status: "loading" });
    try {
      const draft = validate(await transport.reviewHandoffDraft.get(id));
      if (epoch !== generation.current) return;
      update({ scope, text: draft?.text ?? "", savedText: draft?.text ?? "", revision: draft?.revision ?? 0, status: "ready" });
    } catch {
      if (epoch === generation.current) update({ ...stateRef.current, status: "failed" });
    }
  }, [id, owner, scope, transport, update, validate]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active && owner && id) void reload(); });
    return () => { active = false; };
  }, [owner, id, transport, reload]);

  const save = useCallback(async (): Promise<number> => {
    if (!owner || !id || !transport.reviewHandoffDraft) throw Error("REVIEW_HANDOFF_DRAFT_UNAVAILABLE");
    const epoch = generation.current;
    if (pending.current?.generation === epoch) return pending.current.promise;
    const promise = (async () => {
      let current = stateRef.current;
      if (current.scope !== scope || ["loading", "conflict"].includes(current.status)) throw Error("REVIEW_HANDOFF_DRAFT_BLOCKED");
      try {
        // A lost acknowledgement may have committed. Read before attempting another write.
        if (current.status === "failed") {
          const saved = validate(await transport.reviewHandoffDraft!.get(id));
          if (epoch !== generation.current) throw Error("REVIEW_HANDOFF_SCOPE_CHANGED");
          current = stateRef.current;
          if ((saved?.text ?? "") === current.text) {
            current = { ...current, savedText: current.text, revision: saved?.revision ?? 0, status: "ready" };
            update(current);
          } else if ((saved?.revision ?? 0) !== current.revision) {
            update({ ...current, status: "conflict" });
            throw Error("CHAT_DRAFT_REVISION_CONFLICT");
          }
        }
        while (current.text !== current.savedText || current.revision === 0 && current.text.length > 0) {
          update({ ...current, status: "saving" });
          const savedText = current.text;
          const draft = validate(await transport.reviewHandoffDraft!.put(id, { text: savedText, attachmentReferences: [], expectedRevision: current.revision }));
          if (epoch !== generation.current) throw Error("REVIEW_HANDOFF_SCOPE_CHANGED");
          if (!draft) throw Error("REVIEW_HANDOFF_DRAFT_INVALID");
          current = { ...stateRef.current, savedText, revision: draft.revision, status: "ready" };
          update(current);
        }
        if (epoch !== generation.current) throw Error("REVIEW_HANDOFF_SCOPE_CHANGED");
        update({ ...current, status: "ready" });
        return current.revision;
      } catch (error) {
        if (epoch === generation.current) update({ ...stateRef.current, status: (error as { code?: string }).code === "CHAT_DRAFT_REVISION_CONFLICT" || stateRef.current.status === "conflict" ? "conflict" : "failed" });
        throw error;
      }
    })();
    pending.current = { generation: epoch, promise };
    try { return await promise; }
    finally { if (pending.current?.promise === promise) pending.current = null; }
  }, [id, owner, scope, transport, update, validate]);
  const setText = useCallback((text: string) => {
    if (stateRef.current.scope !== scope || stateRef.current.status === "loading") return;
    update({ ...stateRef.current, text });
  }, [scope, update]);
  const visible: DraftState = state.scope === scope ? state : { scope, text: "", savedText: "", revision: 0, status: "loading" };
  useEffect(() => {
    if (!id || !owner || visible.status !== "ready" || visible.text === visible.savedText) return;
    const timer = setTimeout(() => { void save().catch(() => {}); }, 250);
    return () => clearTimeout(timer);
  }, [id, owner, save, visible.savedText, visible.status, visible.text]);
  const blocked = Boolean(id && (visible.status !== "ready" || visible.text !== visible.savedText));
  useEffect(() => {
    if (!blocked || visible.status === "loading") return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [blocked, visible.status]);
  return {
    text: visible.text, setText, save, reload,
    status: visible.status,
    blocked,
    ready: Boolean(id && visible.status === "ready"),
  };
}
