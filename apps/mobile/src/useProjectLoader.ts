import { useCallback, useEffect, useRef, useState } from "react";
import { classifyProjectFailure, createLatestGuard, type ProjectFailure } from "./projectWorkspaceState";

export type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; failure: ProjectFailure };

/**
 * Loads one project resource. Only the newest request may write state: a quick
 * switch to another project (a new `key`), an unmount, or a newer reload makes
 * the older answer be dropped. A session change makes the transport reject
 * with an abort, which is dropped the same way and never shown as an error.
 * A result stored for another key reads as "loading", so a switch never shows
 * the previous project's data. `reload(true)` re-reads without a loading flash.
 */
export function useProjectLoader<T>(load: () => Promise<T>, key: string) {
  const [stored, setStored] = useState<{ key: string; value: Loaded<T> } | null>(null);
  const guard = useRef(createLatestGuard());
  const loader = useRef(load);
  useEffect(() => { loader.current = load; });
  const read = useCallback(async () => {
    const current = guard.current.begin();
    try {
      const data = await loader.current();
      if (current()) setStored({ key, value: { status: "ready", data } });
    } catch (error) {
      const failure = classifyProjectFailure(error);
      if (current() && failure !== "aborted") setStored({ key, value: { status: "error", failure } });
    }
  }, [key]);
  useEffect(() => { const latest = guard.current; void read(); return () => latest.invalidate(); }, [read]);
  const reload = useCallback((quiet = false) => { if (!quiet) setStored({ key, value: { status: "loading" } }); return read(); }, [key, read]);
  const state: Loaded<T> = stored && stored.key === key ? stored.value : { status: "loading" };
  const set = useCallback((value: Loaded<T>) => setStored({ key, value }), [key]);
  return { state, reload, set };
}

export type ActionResult<R> = { ok: true; value: R } | { ok: false; failure: ProjectFailure; error: unknown };

/** Runs one mutation at a time and reports its outcome; nothing is written after unmount. */
export function useProjectAction() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProjectFailure | null>(null);
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async <R,>(work: () => Promise<R>): Promise<ActionResult<R> | null> => {
    if (running.current) return null;
    running.current = true; setBusy(true); setFailure(null);
    try {
      const value = await work();
      return { ok: true, value };
    } catch (error) {
      const kind = classifyProjectFailure(error);
      if (alive.current && kind !== "aborted") setFailure(kind);
      return { ok: false, failure: kind, error };
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }, []);
  return { busy, failure, run, clear: () => setFailure(null) };
}
