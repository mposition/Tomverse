// The statement ceiling every ops-observer store transaction runs under
// (docs/policy/sre-ops.md §6). PostgreSQL has no statement counter, so this is
// an application device and is called one: the database bounds each statement
// and each gap; this bounds how many there are, which is what makes
// C_guarded = A x (statement + idle) an upper figure.
//
// The callback's client can send exactly one kind of thing: a tagged
// `$queryRaw` or `$executeRaw` template, which is one statement -- no `;` in
// its text, and no interpolated Prisma.raw / Prisma.sql fragment that could
// carry one. Every other property that is a function -- every model delegate,
// every *Unsafe method, `$transaction`, and Prisma's internal entry points such
// as `_request` -- refuses, and so does every function reached through a
// nested object. Model delegates are refused outright rather than inspected:
// a relation select, an include, a nested write or a fluent relation call can
// each send more statements than the call that started it, and a list of the
// ways it can happen is a list that will be incomplete.
//
// Code that must use a reviewed fixed-cost helper which needs the real client
// (the audit chain append, for instance) calls `charge(n, fn)`: n statements
// are taken from the allowance first, and only then does `fn` receive the
// client. The cost n is the caller's claim and is pinned by that helper's own
// test.
//
// Exceeding the allowance throws before anything is sent, and the throw rolls
// the whole transaction back. The arming function is statement 1 and is
// counted by the wrapper, so the callback may send A - 1 more.
//
// Pure: no database, no Prisma import. The wrapper passes the real client.

/** The only client methods the callback may call directly. */
export const ONE_STATEMENT_RAW_METHODS = Object.freeze(["$queryRaw", "$executeRaw"]);

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

/** A proxy under which every function refuses. */
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
 * Returns `{ client, charge, used }`: `client` is what the callback may use,
 * `charge(n, fn)` runs a reviewed fixed-cost helper against the real client
 * after taking n statements, and `used()` reports how many were taken.
 */
export function countingClient(tx, allowed) {
  if (!Number.isInteger(allowed) || allowed < 0) throw new Error("ops_observer_statement_allowance_invalid");
  let used = 0;
  const take = (n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error("ops_observer_statement_charge_invalid");
    if (used + n > allowed) refuse("statement_ceiling_exceeded");
    used += n;
  };

  const client = new Proxy(tx, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (ONE_STATEMENT_RAW_METHODS.includes(property) && typeof value === "function") {
        return (...args) => {
          if (!rawCallIsSingleStatement(args)) refuse("statement_ceiling_not_single_statement");
          take(1);
          return value.apply(object, args);
        };
      }
      if (typeof value === "function") return () => refuse("statement_ceiling_unknown_method");
      if (value !== null && typeof value === "object") return refusingProxy(value);
      return value;
    },
  });

  const charge = (n, fn) => {
    take(n);
    return fn(tx);
  };

  return { client, charge, used: () => used };
}
