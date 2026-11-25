import type { AccountDataStatus } from "../account-data-contract";

/** A refusal the main process reports to the renderer as a status (and, when the server gave one, its code). */
export class AccountDataRefusal extends Error {
  constructor(readonly status: AccountDataStatus, readonly code?: string) { super("Account data action refused: " + status); }
}
