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
// There is deliberately no way to hand the callback the real client. A helper
// that needs it -- the audit chain append, whose writer uses model delegates --
// is registered by the wrapper as a named method with a fixed cost, pinned by
// its own test against the statements it actually sends. Calling it takes the
// whole cost before it runs (all of it or none), then runs it on the real
// client inside the closure. The callback never chooses the function or the
// cost, so one call cannot run an unbounded number of statements, and the
// client never reaches the callback.
//
// Exceeding the allowance throws before anything is sent, and the throw rolls
// the whole transaction back. The arming function is statement 1 and is
// counted by the wrapper, so the callback may send A - 1 more.
//
// Pure: no database, no Prisma import. The wrapper passes the real client.

/**
 * Statements one audit chain append sends: the chain lock, the database clock,
 * the previous entry, the insert (lib/adminAudit.ts). Pinned against the
 * writer's actual calls by tests/server-contract/admin-audit-chain-writer.test.ts.
 */
export const AUDIT_APPEND_STATEMENT_COST = 4;

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

/**
 * Something that refuses whatever is done with it: calling it, or reaching any
 * property on it (which is again a refuser). Its target is a fresh empty
 * function, so neither descriptors nor the prototype chain lead anywhere real.
 * `then` reads as absent so that an accidental `await` does not call it.
 */
function refuser() {
  // An arrow function: callable, so apply works, and without a prototype property.
  const self = new Proxy(() => {}, {
    apply: () => refuse("statement_ceiling_unknown_method"),
    construct: () => refuse("statement_ceiling_unknown_method"),
    get: (_target, property) => (property === "then" ? undefined : self),
  });
  return self;
}

/**
 * Wrap `tx` so that at most `allowed` statements can be sent through it.
 * `helpers` maps a `$name` to `{ cost, run(tx, input) }`: registered by the
 * wrapper, never by the callback.
 * Returns `{ client, used }`: `client` is what the callback may use, and
 * `used()` reports how many statements were taken.
 *
 * The client is a facade, not a view of `tx`: its Proxy target is an empty,
 * frozen, prototype-less object, and `tx` lives only in the closures of the two
 * methods. A descriptor, `Object.keys`, `Reflect.ownKeys` or the prototype
 * chain on the client therefore finds nothing of the real client to call.
 */
export function countingClient(tx, allowed, helpers = {}) {
  if (!Number.isInteger(allowed) || allowed < 0) throw new Error("ops_observer_statement_allowance_invalid");
  let used = 0;
  const take = (cost = 1) => {
    if (used + cost > allowed) refuse("statement_ceiling_exceeded");
    used += cost;
  };
  const admit = (args) => {
    if (!rawCallIsSingleStatement(args)) refuse("statement_ceiling_not_single_statement");
    take();
  };
  // Written out, not looked up by name: a computed member on the client is
  // what the protected-table writer check refuses, and rightly.
  const methods = {
    $queryRaw: (...args) => {
      admit(args);
      return tx.$queryRaw(...args);
    },
    $executeRaw: (...args) => {
      admit(args);
      return tx.$executeRaw(...args);
    },
  };

  for (const [name, helper] of Object.entries(helpers)) {
    if (!/^\$[A-Za-z]+$/.test(name) || Object.hasOwn(methods, name)) {
      throw new Error("ops_observer_statement_helper_name_invalid");
    }
    const { cost, run } = helper ?? {};
    if (!Number.isInteger(cost) || cost < 1 || typeof run !== "function") {
      throw new Error("ops_observer_statement_helper_invalid");
    }
    Object.defineProperty(methods, name, {
      enumerable: true,
      value: (input) => {
        take(cost);
        return run(tx, input);
      },
    });
  }

  const client = new Proxy(Object.freeze(Object.create(null)), {
    get: (_target, property) => {
      if (property === "then") return undefined;
      return Object.hasOwn(methods, property) ? methods[property] : refuser();
    },
  });

  return { client, used: () => used };
}
