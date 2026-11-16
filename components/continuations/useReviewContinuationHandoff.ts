"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { continuationPath } from "@/lib/continuationRoutes";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { parseReviewHandoffPreview, reviewHandoffAttemptFor, type ReviewHandoffAttempt, type ReviewHandoffPreview } from "@/lib/reviewContinuationHandoffClient";
import { reviewContinuationHandoffCopy as copy } from "@/locales/reviewContinuationHandoff";

// Survives a lost response and remount, but never a different answer choice.
const attempts = new Map<string, ReviewHandoffAttempt>();

export function useReviewContinuationHandoff(input: {
  identityKey: string | null;
  conversationId: string | null;
  isOwnerCurrent: () => boolean;
  beforeNavigate: () => boolean;
}) {
  const router = useRouter();
  const owner = JSON.stringify([input.identityKey, input.conversationId]);
  const visit = useMemo(() => ({ owner }), [owner]);
  const generation = useRef(0);
  const options = useRef(input);
  const pending = useRef<{ owner: string; anchor: string; generation: number } | null>(null);
  const [state, setState] = useState<{ visit: object; pending: boolean; error: string | null } | null>(null);
  useLayoutEffect(() => { options.current = input; });
  useLayoutEffect(() => {
    generation.current += 1;
    pending.current = null;
    return () => { generation.current += 1; };
  }, [owner]);
  const start = useCallback(async (assistantMessageId: string) => {
    if (!input.identityKey?.startsWith("account:") || !input.conversationId || !options.current.isOwnerCurrent()) return;
    if (pending.current?.owner === owner && pending.current.anchor === assistantMessageId) return;
    const attempt = reviewHandoffAttemptFor(attempts.get(owner), assistantMessageId, () => crypto.randomUUID());
    attempts.set(owner, attempt);
    const epoch = ++generation.current;
    pending.current = { owner, anchor: assistantMessageId, generation: epoch };
    const current = () => generation.current === epoch && options.current.isOwnerCurrent();
    setState({ visit, pending: true, error: null });
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/continuation/review-handoff`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt),
      });
      if (!current()) { await discardResponseBody(response); return; }
      const body = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok) {
        const questionTooLong = body?.code === "REVIEW_HANDOFF_QUESTION_TOO_LONG";
        const modeUnsupported = body?.code === "REVIEW_HANDOFF_MODE_UNSUPPORTED";
        const unsupported = typeof body?.code === "string" && body.code.includes("ATTACHMENT");
        const incomplete = body?.code === "REVIEW_HANDOFF_ANSWER_NOT_COMPLETE" || body?.code === "REVIEW_HANDOFF_ANSWER_NOT_FOUND";
        const textOnly = typeof body?.code === "string" && body.code.includes("UNSUPPORTED");
        setState({ visit, pending: false, error: questionTooLong ? copy.questionTooLong : modeUnsupported ? copy.modeUnsupported : unsupported ? copy.attachmentsUnsupported : textOnly ? copy.unsupported : incomplete ? copy.completedOnly : [403, 404, 423].includes(response.status) ? copy.unavailable : copy.failed });
        return;
      }
      if (typeof body?.conversationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.conversationId)) throw new Error("Invalid handoff target");
      if (!options.current.beforeNavigate()) { setState({ visit, pending: false, error: null }); return; }
      attempts.delete(owner);
      router.push(continuationPath(body.conversationId));
    } catch {
      if (current()) setState({ visit, pending: false, error: copy.failed });
    } finally {
      if (pending.current?.generation === epoch) pending.current = null;
    }
  }, [input.conversationId, input.identityKey, owner, router, visit]);
  return { start, pending: state?.visit === visit && state.pending, error: state?.visit === visit ? state.error : null };
}

/** Resolve access before enabling the dedicated draft transport; generic Review never uses it. */
export function useReviewContinuationDraftAccess(identityKey: string | null, conversationId: string | null, required = false) {
  const [loaded, setLoaded] = useState<{ visit: object; preview: ReviewHandoffPreview | null; failed: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const owner = JSON.stringify([identityKey, conversationId]);
  const visit = useMemo(() => ({ owner }), [owner]);
  const epoch = useRef(0);
  useLayoutEffect(() => { epoch.current += 1; return () => { epoch.current += 1; }; }, [owner]);
  useEffect(() => {
    if (!identityKey?.startsWith("account:") || !conversationId) return;
    const generation = epoch.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=end&limit=1`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) { await discardResponseBody(response); throw new Error("Reference access unavailable"); }
        const body = await response.json();
        if (controller.signal.aborted || epoch.current !== generation) return;
        const preview = parseReviewHandoffPreview(body.reviewHandoff);
        if (body.reviewHandoff && !preview) throw new Error("Invalid reference preview");
        setLoaded({ visit, preview, failed: preview?.status === "unavailable" });
      } catch {
        if (!controller.signal.aborted && epoch.current === generation) setLoaded({ visit, preview: null, failed: true });
      }
    })();
    return () => controller.abort();
  }, [conversationId, identityKey, owner, retry, visit]);
  const enabled = Boolean(identityKey?.startsWith("account:") && conversationId);
  return {
    preview: loaded?.visit === visit ? loaded.preview : null,
    pending: enabled && loaded?.visit !== visit,
    failed: enabled && loaded?.visit === visit && (loaded.failed || (required && !loaded.preview)),
    retry: () => setRetry(value => value + 1),
  };
}
