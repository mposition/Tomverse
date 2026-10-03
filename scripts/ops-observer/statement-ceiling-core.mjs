// The statement ceiling every ops-observer store transaction runs under
// (docs/policy/sre-ops.md §6). PostgreSQL has no statement counter, so this is
// an application device and is called one: the database bounds each statement
// and each gap; this bounds how many there are, which is what makes
// C_guarded = A x (statement + idle) an upper figure.
//
// The callback receives a Proxy over the transaction client. Every call that
// sends a statement -- a model delegate method or a raw query -- is counted
// before it runs. The arming function is statement 1 and is counted by the
// wrapper, so the callback may send A - 1 more. Exceeding that, or calling a
// method this module does not know to be one statement, throws before the
// statement is sent, and the throw rolls the whole transaction back.
//
// Pure: no database, no Prisma import. The wrapper passes the real client.

/** Delegate methods that send exactly one statement. */
export const ONE_STATEMENT_DELEGATE_METHODS = Object.freeze([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "create",
  "createMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** Raw client methods that send exactly one statement. */
export const ONE_STATEMENT_RAW_METHODS = Object.freeze([
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
]);

export class StatementCeilingError extends Error {
  constructor(code) {
    super(code);
    this.name = "StatementCeilingError";
    this.code = code;
  }
}

/**
 * Wrap `tx` so that at most `allowed` statements can be sent through it.
 * Returns `{ client, used }` where `used()` reports how many were counted.
 */
export function countingClient(tx, allowed) {
  if (!Number.isInteger(allowed) || allowed < 0) throw new Error("ops_observer_statement_allowance_invalid");
  let used = 0;
  const take = () => {
    if (used >= allowed) throw new StatementCeilingError("statement_ceiling_exceeded");
    used += 1;
  };

  const delegate = (target) =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property);
        if (typeof value !== "function") return value;
        if (!ONE_STATEMENT_DELEGATE_METHODS.includes(property)) {
          return () => {
            throw new StatementCeilingError("statement_ceiling_unknown_method");
          };
        }
        return (...args) => {
          take();
          return value.apply(object, args);
        };
      },
    });

  const client = new Proxy(tx, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof property === "string" && property.startsWith("$")) {
        if (!ONE_STATEMENT_RAW_METHODS.includes(property)) {
          return () => {
            throw new StatementCeilingError("statement_ceiling_unknown_method");
          };
        }
        return (...args) => {
          take();
          return value.apply(object, args);
        };
      }
      if (value && typeof value === "object") return delegate(value);
      return value;
    },
  });
  return { client, used: () => used };
}
