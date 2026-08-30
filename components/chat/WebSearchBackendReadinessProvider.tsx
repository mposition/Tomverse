"use client";

/**
 * Which application-managed search backends this deployment can reach, made
 * available to the composer, the model picker and the message list.
 *
 * ## Why a context and not a prop
 *
 * The value is one boolean per backend and it never changes while the page is
 * open, which is the shape a prop is usually right for. Its *consumers* are
 * what make it wrong: the web-search chip in `ChatInput`, the search badge and
 * the "Web search" filter inside `ModelCatalogue` (three components down, behind
 * a dynamic import), the recommendation rows in `ModelPickerPanel`, and the
 * per-message badge in `ChatMessageList` (rendered by `ChatApp`). Threading a
 * prop to all four means five intermediate components carrying a value they do
 * not use, and the day one of them is refactored the prop silently stops
 * arriving somewhere.
 *
 * ## Why the default is "nothing is reachable"
 *
 * Because that is the only default that fails in the safe direction. A consumer
 * rendered outside the provider gets no backends, so a Gemini model is shown as
 * unable to search -- a conservative answer that costs the user a feature they
 * might have had. The opposite default would show the model as search-ready on
 * a deployment with no credential, take the eight-credit surcharge, and refuse
 * at dispatch: the exact failure `nativeSearchIsDispatchable` was introduced to
 * end, reproduced one layer up.
 *
 * ## What crosses the boundary
 *
 * Booleans. The credential itself is read only by `server-only` code
 * (`lib/webSearchBackendRuntime.ts`); the server resolves readiness, and what
 * the browser receives is "brave: true". No key, no environment variable name,
 * no budget figure.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  NO_WEB_SEARCH_BACKENDS,
  type WebSearchBackendReadiness,
} from "@/lib/webSearchBackends";

const WebSearchBackendReadinessContext =
  createContext<WebSearchBackendReadiness>(NO_WEB_SEARCH_BACKENDS);

export function WebSearchBackendReadinessProvider({
  readiness,
  children,
}: {
  readiness: WebSearchBackendReadiness | undefined;
  children: ReactNode;
}) {
  // Memoised on the identity of what the server sent rather than on the object,
  // which is re-created by every RSC payload parse. Without this every consumer
  // re-renders on each parent render for a value that did not change.
  const value = useMemo<WebSearchBackendReadiness>(
    () => readiness ?? NO_WEB_SEARCH_BACKENDS,
    [readiness]
  );
  return (
    <WebSearchBackendReadinessContext.Provider value={value}>
      {children}
    </WebSearchBackendReadinessContext.Provider>
  );
}

/**
 * The readiness map, for a client component deciding whether a model searches.
 *
 * Always returns a map -- never undefined -- so a consumer cannot accidentally
 * pass `undefined` into a function whose whole point is that the answer is
 * required.
 */
export const useWebSearchBackendReadiness = (): WebSearchBackendReadiness =>
  useContext(WebSearchBackendReadinessContext);
