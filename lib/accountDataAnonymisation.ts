import "server-only";

// Anonymising the rows that outlive an account, as the data-domain registry
// says they are anonymised.
//
// Four tables relate to User with `onDelete: SetNull`, which clears userId and
// nothing else. That is the shape the registry exists to catch: a row with
// userId NULL that still carries subjectKey, traceId and a provider request
// identifier has not been anonymised, it has been renamed. Any of those three
// re-joins the row to the person -- subjectKey and traceId against Tomverse's
// own logs, providerRequestId against the provider's records, which are held by
// somebody else entirely and outlive anything decided here.
//
// The column list below is the registry's `anonymisationFields`, and
// tests/accountDataAnonymisation.test.mjs fails if the two drift. That is the
// point of writing it twice: the registry is the decision, this is the
// implementation, and neither can quietly stop matching the other.
//
// Raw SQL rather than updateMany because two of the columns are UNIQUE. Every
// anonymised row would collide on a shared placeholder, so those take the row's
// own primary key -- which is not a value updateMany can express.

import type { Prisma } from "@prisma/client";

/**
 * How a column stops naming the person.
 *
 *   null      the column is nullable, so NULL is available and says the least.
 *   literal   the column is NOT NULL. A fixed value that is obviously not real.
 *   perRow    the column is UNIQUE. A shared literal would collide, so the
 *             replacement carries the row's own id.
 *   emptyJson a JSONB column whose contents are a snapshot of the request.
 */
export type AnonymisationReplacement =
  | { kind: "null" }
  | { kind: "literal"; value: string }
  | { kind: "perRow"; prefix: string }
  | { kind: "emptyJson" };

export type AccountAnonymisation = {
  prismaModel: string;
  table: string;
  /** The column carrying the user link, used to find the rows. */
  userColumn: string;
  columns: Record<string, AnonymisationReplacement>;
};

/** The placeholder left where a NOT NULL identifier used to be. */
export const ANONYMISED_SUBJECT = "deleted-account";

export const ACCOUNT_ANONYMISATIONS: AccountAnonymisation[] = [
  {
    prismaModel: "ChatLimitDecisionEvent",
    table: "ChatLimitDecisionEvent",
    userColumn: "userId",
    columns: {
      // Nullable, but no relation at all -- so nothing clears it today and the
      // row keeps naming the user until the 90-day purge reaches it.
      userId: { kind: "null" },
      subjectKey: { kind: "literal", value: ANONYMISED_SUBJECT },
      traceId: { kind: "literal", value: ANONYMISED_SUBJECT },
    },
  },
  {
    prismaModel: "ChatCreditReservation",
    table: "ChatCreditReservation",
    userColumn: "userId",
    columns: {
      userId: { kind: "null" },
      subjectKey: { kind: "literal", value: ANONYMISED_SUBJECT },
      traceId: { kind: "literal", value: ANONYMISED_SUBJECT },
      providerRequestId: { kind: "null" },
      providerResponseId: { kind: "null" },
      // The per-lot refund entries. The lots themselves cascade away with the
      // account, so there is nothing left for a reconciliation sweep to refund
      // and nothing lost by clearing the snapshot of what it would have been.
      reservationPayload: { kind: "emptyJson" },
      providerUsageSnapshot: { kind: "null" },
    },
  },
  {
    prismaModel: "ImageCreditReservation",
    table: "ImageCreditReservation",
    userColumn: "userId",
    columns: {
      userId: { kind: "null" },
      // UNIQUE. Points at an ImageGeneration that cascades away, but the
      // identifier is what other logs recorded, so it is the join that matters
      // rather than the row it used to reach.
      generationId: { kind: "perRow", prefix: "anonymised:" },
      conversationId: { kind: "null" },
      targetId: { kind: "null" },
      providerRequestId: { kind: "null" },
      reservationPayload: { kind: "emptyJson" },
    },
  },
  {
    prismaModel: "MemoryExtractionCreditReservation",
    table: "MemoryExtractionCreditReservation",
    userColumn: "userId",
    columns: {
      userId: { kind: "null" },
      // UNIQUE, same reasoning as generationId above.
      runId: { kind: "perRow", prefix: "anonymised:" },
      reservationPayload: { kind: "emptyJson" },
    },
  },
];

// Identifiers are interpolated into the statement, so they are checked even
// though they come from the literal above rather than from a request. A
// declaration is a thing somebody edits, and an edit is where the assumption
// that they are safe stops holding.
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

const assertIdentifier = (value: string, what: string) => {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Unsafe ${what} in an account anonymisation: ${value}`);
  }
  return value;
};

/**
 * Renders one table's UPDATE. Column names are identifiers and are validated;
 * every value is a bound parameter.
 */
export const buildAnonymisationStatement = (
  anonymisation: AccountAnonymisation
): { sql: string; values: (string | null)[]; userParameterIndex: number } => {
  const table = assertIdentifier(anonymisation.table, "table name");
  const assignments: string[] = [];
  const values: (string | null)[] = [];

  for (const [column, replacement] of Object.entries(anonymisation.columns)) {
    const name = assertIdentifier(column, "column name");
    switch (replacement.kind) {
      case "null":
        assignments.push(`"${name}" = NULL`);
        break;
      case "literal":
        values.push(replacement.value);
        assignments.push(`"${name}" = $${values.length}`);
        break;
      case "perRow":
        values.push(replacement.prefix);
        assignments.push(`"${name}" = $${values.length} || "id"`);
        break;
      case "emptyJson":
        assignments.push(`"${name}" = '{}'::jsonb`);
        break;
    }
  }

  values.push(null); // placeholder for userId, bound by the caller
  const userParameterIndex = values.length;
  const userColumn = assertIdentifier(anonymisation.userColumn, "user column");

  return {
    sql: `UPDATE "${table}" SET ${assignments.join(", ")} WHERE "${userColumn}" = $${userParameterIndex}`,
    values,
    userParameterIndex,
  };
};

/**
 * Anonymises every declared table for one account.
 *
 * MUST run before the User row is deleted. Three of these four relations are
 * `onDelete: SetNull`, so once the user is gone the userId is already NULL and
 * there is nothing left to match on -- the rows would keep their subject keys,
 * trace identifiers and provider request identifiers forever.
 */
export const anonymiseAccountData = async (
  tx: Prisma.TransactionClient,
  userId: string
) => {
  const anonymised: Record<string, number> = {};
  for (const anonymisation of ACCOUNT_ANONYMISATIONS) {
    const statement = buildAnonymisationStatement(anonymisation);
    const values = [...statement.values];
    values[statement.userParameterIndex - 1] = userId;
    anonymised[anonymisation.prismaModel] = await tx.$executeRawUnsafe(
      statement.sql,
      ...values
    );
  }
  return anonymised;
};
