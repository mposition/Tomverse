/**
 * The one log line an unattended registration leaves when it does not commit.
 *
 * The result route turns any registration error it does not recognise into
 * `outcome_unknown` for the runner, so without this line the cause is lost.
 * Only closed identifiers are kept: the error class, its own code (a Prisma
 * `P2xxx` or a registration refusal) and the database SQLSTATE. Messages,
 * stacks and every plan, path or card value stay out.
 */
export const AMUX_V19_REGISTRATION_FAILED_EVENT =
  "amux_v19_system_registration_failed" as const;

const NAME = /^[A-Za-z][A-Za-z0-9_$]{0,63}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type Fields = Record<string, unknown>;

const fieldsOf = (value: unknown): Fields | null =>
  value !== null && typeof value === "object" ? value as Fields : null;

const closed = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

export function amuxV19RegistrationFailureLog(ideaId: string, error: unknown) {
  const fields = fieldsOf(error);
  const meta = fieldsOf(fields?.meta);
  return {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT,
    ideaId: closed(ideaId, IDEA_ID),
    errorName: error instanceof Error
      ? closed(error.name, NAME) ?? "Error" : typeof error,
    errorCode: closed(fields?.code, CODE),
    // Prisma reports the PostgreSQL error code of a failed raw statement here,
    // for example 57014 (statement timeout) or 40001 (serialization failure).
    dbCode: closed(meta?.code, SQLSTATE),
  };
}
