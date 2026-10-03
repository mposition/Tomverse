// The statement ceiling every ops-observer store transaction runs under
// (docs/policy/sre-ops.md §6). PostgreSQL has no statement counter, so this is
// an application device and is called one: the database bounds each statement
// and each gap; this bounds how many there are, which is what makes
// C_guarded = A x (statement + idle) an upper figure.
//
// A call is counted as one statement only when it cannot send more than one.
// So the client refuses, before anything is sent:
//
//   - a delegate call whose arguments could fan out into several queries: an
//     `include`, a `select` that reaches a relation, or relation write
//     operators (create, connect, upsert, ...) anywhere inside `data`;
//   - a delegate method not on the one-statement list (upsert, for instance,
//     may be a SELECT and then a write);
//   - a raw call that is not a tagged template, whose text holds a `;`, or
//     that interpolates a Prisma.raw / Prisma.sql fragment (which could carry
//     a `;` past the text check); and every *Unsafe raw method;
//   - any function reached through a nested object, which is neither a
//     delegate method nor a raw method.
//
// The arming function is statement 1 and is counted by the wrapper, so the
// callback may send A - 1 more. Exceeding that throws before the statement is
// sent, and the throw rolls the whole transaction back.
//
// Pure: no database, no Prisma import. The wrapper passes the real client.

/** Delegate methods that send exactly one statement when their arguments cannot fan out. */
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

/** Raw client methods that send exactly one statement when called as a tagged template. */
export const ONE_STATEMENT_RAW_METHODS = Object.freeze(["$queryRaw", "$executeRaw"]);

/** Prisma's relation write operators: any of them inside `data` is another statement. */
export const RELATION_WRITE_OPERATORS = Object.freeze([
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "set",
  "disconnect",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "upsert",
]);

export class StatementCeilingError extends Error {
  constructor(code) {
    super(code);
    this.name = "StatementCeilingError";
    this.code = code;
  }
}

const refuse = (code) => {
  throw new StatementCeilingError(code);
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function dataFansOut(data) {
  const rows = Array.isArray(data) ? data : [data];
  return rows.some(
    (row) =>
      isPlainObject(row) &&
      Object.values(row).some(
        (value) => isPlainObject(value) && Object.keys(value).some((key) => RELATION_WRITE_OPERATORS.includes(key)),
      ),
  );
}

/** Whether delegate arguments could make Prisma send more than one statement. */
export function delegateArgsFanOut(args) {
  if (!isPlainObject(args)) return false;
  if ("include" in args) return true;
  if (isPlainObject(args.select) && Object.values(args.select).some((v) => v !== true && v !== false)) return true;
  if ("data" in args && dataFansOut(args.data)) return true;
  if ("create" in args || "update" in args) return true; // upsert-shaped arguments
  return false;
}

const isSqlFragment = (v) => v !== null && typeof v === "object" && Array.isArray(v.strings) && "values" in v;

/** Whether a raw call is a single-statement tagged template. */
export function rawCallIsSingleStatement(args) {
  const [strings, ...values] = args;
  const isTemplate = Array.isArray(strings) && Array.isArray(strings.raw);
  if (!isTemplate) return false;
  if (strings.join("").includes(";")) return false;
  if (values.some(isSqlFragment)) return false;
  return true;
}

/** A proxy under which every function refuses: nothing nested is a counted statement. */
function refusingProxy(target) {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value === "function") return () => refuse("statement_ceiling_unknown_method");
      if (value !== null && typeof value === "object") return refusingProxy(value);
      return value;
    },
  });
}

/**
 * Wrap `tx` so that at most `allowed` statements can be sent through it.
 * Returns `{ client, used }` where `used()` reports how many were counted.
 */
export function countingClient(tx, allowed) {
  if (!Number.isInteger(allowed) || allowed < 0) throw new Error("ops_observer_statement_allowance_invalid");
  let used = 0;
  const take = () => {
    if (used >= allowed) refuse("statement_ceiling_exceeded");
    used += 1;
  };

  const delegate = (target) =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property);
        if (typeof value === "function") {
          if (!ONE_STATEMENT_DELEGATE_METHODS.includes(property)) {
            return () => refuse("statement_ceiling_unknown_method");
          }
          return (...args) => {
            if (delegateArgsFanOut(args[0])) refuse("statement_ceiling_fan_out");
            take();
            return value.apply(object, args);
          };
        }
        if (value !== null && typeof value === "object") return refusingProxy(value);
        return value;
      },
    });

  const client = new Proxy(tx, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof property === "string" && property.startsWith("$")) {
        if (!ONE_STATEMENT_RAW_METHODS.includes(property) || typeof value !== "function") {
          return () => refuse("statement_ceiling_unknown_method");
        }
        return (...args) => {
          if (!rawCallIsSingleStatement(args)) refuse("statement_ceiling_not_single_statement");
          take();
          return value.apply(object, args);
        };
      }
      if (value !== null && typeof value === "object") return delegate(value);
      return value;
    },
  });
  return { client, used: () => used };
}
