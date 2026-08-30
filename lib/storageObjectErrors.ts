/**
 * What an object-storage failure *is*, before anything decides what to do
 * about it.
 *
 * Written after a production incident in which a signed-in user's JPEG had
 * been removed from R2 by a time-based bucket lifecycle rule while the
 * `MessageAttachment` row that referenced it was still there. Every later turn
 * in that conversation re-read the file, the AWS SDK threw `NotFound`, and the
 * error travelled all the way to the chat route's outermost catch -- which by
 * then had a provider in hand and therefore filed a local storage 404 as
 * `AI_REQUEST_FAILED.NotFound`. Two different providers were charged with an
 * outage neither had; switching models could not help, because the failure was
 * on this side of the network.
 *
 * The lesson is narrow and mechanical: **an error has a layer, and the layer
 * has to be decided where the error is raised, not where it is caught.** By
 * the time a stack unwinds to a route's last catch, the only things still in
 * scope are the things that were in scope for everything -- and a provider
 * name in scope is not evidence that a provider was called.
 *
 * Pure and dependency-free on purpose. No AWS SDK import, no `server-only`:
 * the S3 client's error shapes are duck-typed here so that a unit test can
 * hand this module a plain object, and so that the classification can be read
 * by scripts that never construct an S3 client at all.
 */

/** What went wrong with the object, in the only terms a caller can act on. */
export const STORAGE_FAILURE_KINDS = [
  /** The object is not there. Confirmed, not inferred. */
  "missing",
  /** The credentials or the policy refused us. Ours to fix, not the user's. */
  "denied",
  /** Storage did not answer, or answered 5xx/408/429. Try again later. */
  "unreachable",
  /** Storage answered, but what came back was not what the row described. */
  "invalid",
  /** Something else. Never treated as `missing`. */
  "unknown",
] as const;

export type StorageFailureKind = (typeof STORAGE_FAILURE_KINDS)[number];

/**
 * Only one of these means "the bytes are gone".
 *
 * The distinction is the whole point of this module: a 403 from a rotated key
 * and a 404 from a lifecycle deletion look equally like "the read failed", and
 * recording the first as permanent loss would mark every attachment in the
 * account unavailable during a credentials outage.
 */
export const isPermanentStorageLoss = (kind: StorageFailureKind) =>
  kind === "missing";

/** Storage operations named in structured logs. No key ever appears beside them. */
export type StorageOperation =
  | "head"
  | "get"
  | "put"
  | "delete"
  | "list"
  | "probe";

const MISSING_NAMES = new Set([
  "NotFound",
  "NoSuchKey",
  "NoSuchVersion",
  "ObjectNotInActiveTierError",
]);

const DENIED_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "TokenRefreshRequired",
  "UnrecognizedClientException",
  "CredentialsProviderError",
]);

const UNREACHABLE_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeTooSkewed",
  "AbortError",
  "NetworkingError",
  "InternalError",
  "ServiceUnavailable",
  "SlowDown",
  "ThrottlingException",
]);

const UNREACHABLE_CODES = /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+)$/;

/**
 * The HTTP status an SDK error is carrying, wherever it put it.
 *
 * `$metadata.httpStatusCode` is where the AWS SDK v3 keeps it, and it is the
 * one place `safeErrorMetadata` in lib/providerErrorClassification.ts did not
 * look -- which is how a 404 from R2 reached provider classification with no
 * status at all and fell through to the "counted against the provider"
 * default.
 */
export const storageErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    httpStatusCode?: unknown;
    statusCode?: unknown;
    status?: unknown;
    /** One of this module's own errors, which kept the status when it wrapped. */
    storageStatus?: unknown;
  };
  const values = [
    candidate.storageStatus,
    candidate.$metadata?.httpStatusCode,
    candidate.httpStatusCode,
    candidate.statusCode,
    candidate.status,
  ];
  for (const value of values) {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 100 &&
      value <= 599
    ) {
      return value;
    }
  }
  return null;
};

const errorName = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  for (const value of [candidate.name, candidate.Code, candidate.code]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const errorCode = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code.trim() : "";
};

/**
 * Decides what an object-storage failure is evidence of.
 *
 * Name first, then status. The SDK's own error name is the stronger signal:
 * `HeadObject` on a missing key throws `NotFound` with
 * `$metadata.httpStatusCode === 404`, but a proxy in front of the bucket can
 * put a 404 on something else entirely, and a bare status is a weaker claim
 * than the service naming its own condition.
 */
export const classifyStorageError = (error: unknown): StorageFailureKind => {
  if (error instanceof StorageObjectMissingError) return "missing";
  if (error instanceof StorageObjectInvalidError) return "invalid";
  if (error instanceof StorageUnavailableError) return error.kind;

  const name = errorName(error);
  if (MISSING_NAMES.has(name)) return "missing";
  if (DENIED_NAMES.has(name)) return "denied";
  if (UNREACHABLE_NAMES.has(name)) return "unreachable";
  if (UNREACHABLE_CODES.test(errorCode(error))) return "unreachable";

  const status = storageErrorStatus(error);
  if (status === 404 || status === 410) return "missing";
  if (status === 401 || status === 403) return "denied";
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return "unreachable";
  }
  return "unknown";
};

/** True only for a confirmed 404-shaped answer from storage. */
export const isStorageObjectMissing = (error: unknown): boolean =>
  classifyStorageError(error) === "missing";

/**
 * Base class for every failure this application raises *about storage*.
 *
 * The class, not the message, is what the chat route's boundary matches on:
 * a string test would have to be repeated at each catch and would drift the
 * first time an SDK renamed a condition.
 *
 * Nothing here carries the object key, the bucket, the endpoint or the raw
 * SDK payload. The original error is kept on `cause` for the process that
 * raised it and is never serialised by any of this module's helpers --
 * docs/policy/user-attachment-persistence.md section 5 is a rule about
 * responses, and an error message is a response the moment somebody logs it.
 */
export class StorageError extends Error {
  constructor(
    readonly kind: StorageFailureKind,
    readonly operation: StorageOperation,
    readonly storageStatus: number | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions);
    this.name = "StorageError";
  }
}

/** The object is gone. Confirmed by storage, not guessed from a failed read. */
export class StorageObjectMissingError extends StorageError {
  readonly code = "STORAGE_OBJECT_MISSING";

  constructor(operation: StorageOperation, options?: { cause?: unknown }) {
    super("missing", operation, 404, "The stored object no longer exists.", options);
    this.name = "StorageObjectMissingError";
  }
}

/**
 * Storage could not answer, or refused us.
 *
 * Deliberately one class for `denied`, `unreachable` and `unknown`: all three
 * mean *we do not know whether the object exists*, and every caller that has
 * to choose between "tell the user their file is gone" and "ask them to try
 * again" makes the same choice for all three.
 */
export class StorageUnavailableError extends StorageError {
  readonly code = "STORAGE_UNAVAILABLE";

  constructor(
    kind: Exclude<StorageFailureKind, "missing" | "invalid">,
    operation: StorageOperation,
    storageStatus: number | null,
    options?: { cause?: unknown }
  ) {
    super(
      kind,
      operation,
      storageStatus,
      "Object storage could not be read.",
      options
    );
    this.name = "StorageUnavailableError";
  }
}

/** Storage answered, and what it holds is not what the row said it was. */
export class StorageObjectInvalidError extends StorageError {
  readonly code = "STORAGE_OBJECT_INVALID";

  constructor(operation: StorageOperation, options?: { cause?: unknown }) {
    super("invalid", operation, null, "The stored object is not valid.", options);
    this.name = "StorageObjectInvalidError";
  }
}

export const isStorageError = (error: unknown): error is StorageError =>
  error instanceof StorageError;

/**
 * Turns whatever the SDK threw into one of the classes above.
 *
 * Idempotent: a `StorageError` passed back in is returned unchanged, so a
 * helper that wraps a helper does not double-classify.
 */
export const toStorageError = (
  operation: StorageOperation,
  error: unknown
): StorageError => {
  if (error instanceof StorageError) return error;
  const kind = classifyStorageError(error);
  const status = storageErrorStatus(error);
  if (kind === "missing") {
    return new StorageObjectMissingError(operation, { cause: error });
  }
  if (kind === "invalid") {
    return new StorageObjectInvalidError(operation, { cause: error });
  }
  return new StorageUnavailableError(kind, operation, status, { cause: error });
};

/**
 * The fields a storage failure may appear with in a log line, a Sentry tag or
 * an admin screen.
 *
 * An allowlist rather than a redaction pass: a redactor has to be right about
 * every field an SDK might add, and this has to be right about six it emits.
 * No key, no bucket, no endpoint, no filename, no SDK payload.
 */
export const storageFailureTelemetry = (error: unknown) => {
  const kind = classifyStorageError(error);
  return {
    storageFailureKind: kind,
    storageStatus: storageErrorStatus(error),
    permanent: isPermanentStorageLoss(kind),
    ...(error instanceof StorageError ? { storageOperation: error.operation } : {}),
  };
};
