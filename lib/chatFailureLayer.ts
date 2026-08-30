/**
 * Which layer a chat-turn failure came from, decided where it is raised.
 *
 * `POST /api/chat` is one long function with one outermost catch, and that
 * catch used to file everything it saw as `AI_REQUEST_FAILED` because, by the
 * time it ran, a provider had been chosen and `dispatchProviderForLog` was
 * set. Choosing a provider is not calling one. A storage 404 raised while
 * building the prompt, hundreds of lines before any request left the process,
 * was recorded as that provider's failure and counted against its health --
 * so every model in the conversation failed, and no model could clear it.
 *
 * The fix is not a boolean saying "we started the call". A boolean is a claim
 * anybody can forget to set, and its absence looks exactly like its false. The
 * fix is that the preparation stages *say what they are* by throwing a typed
 * error: anything wrapped in `ChatLocalFailure` was raised before the provider
 * boundary and cannot be provider evidence, whatever else is in scope.
 *
 * Pure and dependency-free, so the taxonomy is testable without a route, a
 * database or a network.
 */

/**
 * Where a failure happened, ordered by how far the request got.
 *
 * Only the last two are ever provider health evidence. That is the entire
 * contract this file exists to state.
 */
export const CHAT_FAILURE_LAYERS = [
  /** The request itself was malformed or not allowed. Nothing was attempted. */
  "validation",
  /** Object storage: reading an attachment, an artifact, a knowledge chunk. */
  "storage",
  /** Our own code or database: a query, a transaction, a bug. */
  "application",
  /** An HTTP request left this process for a provider and failed. */
  "provider_request",
  /** A provider stream was open and failed part way through. */
  "provider_stream",
] as const;

export type ChatFailureLayer = (typeof CHAT_FAILURE_LAYERS)[number];

/** The layers that are raised on this side of the provider boundary. */
export const LOCAL_CHAT_FAILURE_LAYERS = [
  "validation",
  "storage",
  "application",
] as const satisfies readonly ChatFailureLayer[];

export type LocalChatFailureLayer = (typeof LOCAL_CHAT_FAILURE_LAYERS)[number];

export const isProviderFailureLayer = (
  layer: ChatFailureLayer | null | undefined
): boolean => layer === "provider_request" || layer === "provider_stream";

/**
 * Named points in a turn, for `TraceErrorEvidence.phase` and structured logs.
 *
 * A phase is coarser than a line number and finer than "request": it is the
 * thing an operator reads to know whether to look at the bucket, the database
 * or the provider status page.
 */
export const CHAT_FAILURE_PHASES = [
  "request_validation",
  "attachment_resolve",
  "attachment_read",
  "context_build",
  "persistence",
  "request",
  "stream",
] as const;

export type ChatFailurePhase = (typeof CHAT_FAILURE_PHASES)[number];

/**
 * A failure raised before the provider boundary.
 *
 * Carries its own diagnostic code rather than borrowing `AI_REQUEST_FAILED`,
 * because the code is what `classifyProviderFailure` reads: a root outside
 * `PROVIDER_CALL_DIAGNOSTIC_ROOTS` is classified `LOCAL_REJECTION` with scope
 * `none`, which is exactly what a storage 404 is.
 *
 * The original error is on `cause`. Nothing in this class reaches a client:
 * the route turns it into a code and a status, and the code is the only part
 * of it a user ever sees.
 */
export class ChatLocalFailure extends Error {
  constructor(
    readonly layer: LocalChatFailureLayer,
    readonly phase: ChatFailurePhase,
    readonly diagnosticCode: string,
    options?: { cause?: unknown; storageStatus?: number | null }
  ) {
    super(`Chat turn failed locally at ${phase} (${layer}).`, {
      cause: options?.cause,
    } as ErrorOptions);
    this.name = "ChatLocalFailure";
    this.storageStatus = options?.storageStatus ?? null;
  }

  readonly storageStatus: number | null;
}

export const isChatLocalFailure = (error: unknown): error is ChatLocalFailure =>
  error instanceof ChatLocalFailure;

/**
 * Diagnostic-code roots this module mints. None of them may ever be added to
 * `PROVIDER_CALL_DIAGNOSTIC_ROOTS`; that is the point of them being separate
 * words rather than a suffix on `AI_REQUEST_FAILED`.
 */
export const LOCAL_FAILURE_DIAGNOSTIC_ROOTS = [
  "CHAT_STORAGE_FAILED",
  "CHAT_APPLICATION_FAILED",
  "CHAT_VALIDATION_FAILED",
] as const;

const ROOT_FOR_LAYER: Record<LocalChatFailureLayer, string> = {
  storage: "CHAT_STORAGE_FAILED",
  application: "CHAT_APPLICATION_FAILED",
  validation: "CHAT_VALIDATION_FAILED",
};

/**
 * Builds the diagnostic code for a local failure.
 *
 * Shaped like `providerDiagnosticCode` -- dot-joined, uppercase, bounded --
 * so the same log tooling reads both, but rooted in a word no provider
 * classifier accepts.
 */
export const localDiagnosticCode = (
  layer: LocalChatFailureLayer,
  detail?: string | null,
  storageStatus?: number | null
): string =>
  [
    ROOT_FOR_LAYER[layer],
    detail ? detail.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) : null,
    typeof storageStatus === "number" ? `HTTP_${storageStatus}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(".");

/**
 * Runs one preparation stage inside a typed boundary.
 *
 * Anything the stage throws that is not already a deliberate refusal comes
 * back out as a `ChatLocalFailure` naming this layer and phase. `isRefusal` is
 * injected rather than imported so this file stays pure: the route passes
 * `isChatAccessError`, which is the module that owns that class answering for
 * its own instances (class identity is per module instance, and `instanceof`
 * across a re-evaluated module is silently false).
 *
 * The wrapping is what makes the outer catch's job mechanical instead of
 * inferential: it no longer has to reason about how far the request got, it
 * only has to ask what kind of error it is holding.
 */
export const runLocalStage = async <T>(
  descriptor: {
    layer: LocalChatFailureLayer;
    phase: ChatFailurePhase;
    /** Maps a caught error to a diagnostic detail + storage status, if it can. */
    describe?: (error: unknown) => {
      detail?: string | null;
      storageStatus?: number | null;
    };
  },
  isRefusal: (error: unknown) => boolean,
  run: () => Promise<T>
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (isRefusal(error) || error instanceof ChatLocalFailure) throw error;
    const described = descriptor.describe?.(error) || {};
    throw new ChatLocalFailure(
      descriptor.layer,
      descriptor.phase,
      localDiagnosticCode(
        descriptor.layer,
        described.detail,
        described.storageStatus
      ),
      { cause: error, storageStatus: described.storageStatus ?? null }
    );
  }
};

/* ------------------------------------------------------------------------ */
/* The provider boundary                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Proof that a request left this process for a provider.
 *
 * A class, not a boolean and not an object literal. A boolean is a claim any
 * branch can forget to make, and its absence is indistinguishable from its
 * `false`; an instance of this can only exist because `beginProviderCall`
 * constructed one, so "did we call a provider" becomes a structural question
 * rather than a trusting one.
 */
export class ProviderCallRecord {
  constructor(
    readonly provider: string,
    readonly modelId: string,
    readonly startedAt: number = Date.now()
  ) {}
}

/** An error thrown by the provider call itself. Provider health evidence. */
export class ProviderRequestFailure extends Error {
  constructor(
    readonly call: ProviderCallRecord,
    readonly reason: unknown
  ) {
    super("The provider call failed.", { cause: reason } as ErrorOptions);
    this.name = "ProviderRequestFailure";
  }
}

export const isProviderRequestFailure = (
  error: unknown
): error is ProviderRequestFailure => error instanceof ProviderRequestFailure;

/**
 * Runs the one call that may become provider health evidence.
 *
 * Everything this wrapper touches is on the far side of the boundary: it
 * mints the record *before* the call so a failure still proves the attempt,
 * and it re-throws as `ProviderRequestFailure` so the handler's outermost
 * catch can tell "the provider refused us" from "we never got that far"
 * without reasoning about how much of the function had run.
 *
 * `onStart` hands the record back to the caller, which is what lets an error
 * raised *after* a successful dispatch -- inside stream setup, say -- still be
 * attributed to the provider that was already talking to us.
 */
export const beginProviderCall = async <T>(
  provider: string,
  modelId: string,
  onStart: (record: ProviderCallRecord) => void,
  // Sync or async: `streamText` returns its result object immediately and
  // throws synchronously for a malformed request, while other adapters return
  // a promise. Both are dispatch attempts and both belong inside the boundary.
  call: () => T | Promise<T>
): Promise<T> => {
  const record = new ProviderCallRecord(provider, modelId);
  onStart(record);
  try {
    return (await call()) as T;
  } catch (error) {
    if (error instanceof ChatLocalFailure) throw error;
    throw new ProviderRequestFailure(record, error);
  }
};
