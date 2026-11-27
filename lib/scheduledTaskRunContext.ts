import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "next-auth";

/**
 * The one way a scheduled run acts as its account.
 *
 * A scheduled run is an ordinary Chat turn: the runner builds the request a
 * signed-in browser would send and hands it to the Chat route's own handler,
 * in this process. What it does not have is a cookie or a bearer token, and
 * it must not get one -- minting a credential for the server to impersonate
 * an account would be a new authentication path that outlives the run.
 *
 * So the identity travels in an AsyncLocalStorage store instead. It cannot be
 * reached from a network request: only code that calls `runAsScheduledTask`
 * opens one, and the store is bound to the exact Request object the runner
 * built, so even code inside the run that handles some other Request sees
 * nothing. The account is the one that owns the task row the runner claimed;
 * the row is the authority, as a Research run's row is for its worker.
 *
 * Kept on `globalThis` under a registered symbol so a second copy of this
 * module in another server bundle reads the same store rather than an empty
 * one.
 */

export type ScheduledTaskRunScope = {
  runId: string;
  userId: string;
  session: Session;
  request: Request;
  /** The per-run credits the account approved when it saved the task. */
  creditCeiling: number;
};

const STORE_KEY = Symbol.for("tomverse.scheduledTaskRunScope");
const storage: AsyncLocalStorage<ScheduledTaskRunScope> = (() => {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: AsyncLocalStorage<ScheduledTaskRunScope> };
  holder[STORE_KEY] ??= new AsyncLocalStorage<ScheduledTaskRunScope>();
  return holder[STORE_KEY];
})();

export const runAsScheduledTask = <T>(scope: ScheduledTaskRunScope, run: () => Promise<T>): Promise<T> =>
  storage.run(Object.freeze({ ...scope }), run);

export const currentScheduledTaskRun = (): ScheduledTaskRunScope | null => storage.getStore() ?? null;

/** The run's session, only for the Request the runner built. */
export const scheduledTaskRunSession = (request: Request): Session | null => {
  const scope = storage.getStore();
  return scope && scope.request === request ? scope.session : null;
};
