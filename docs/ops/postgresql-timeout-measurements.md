# PostgreSQL timeout behaviour — measured, not inferred

**Method.** A throwaway cluster created with `initdb` on 2026-09-22, PostgreSQL
**17.10 on x86_64-windows**, default configuration, trust auth on 127.0.0.1:55432,
driven by plain `psql`. Not the production database, and not touched by any
product code. The cluster was stopped and its data directory removed afterwards.

**Why this exists.** Five designs spent several review rounds arguing these points
from source. One of those arguments — written into the foundation as r12 — was
wrong, and the correction (r13) was itself an inference. These are executions.

**Where this lives.** `docs/ops/postgresql-timeout-measurements.md`. This was written
as an audit record on a branch that was never pushed, which made every citation of
its section numbers unfollowable — the reader was sent to a file that is in no
checkout. The agent policies that state PostgreSQL facts cite these sections for
each one, so the record is published here with its content
unchanged, including the two places where it corrects something the coordinating
session had asserted and got wrong: the r12 reading named above, and §11. Nothing
here is an attack path, a credential or product data — it is PostgreSQL behaviour
measured on a throwaway local cluster, and the limits of that are stated below.

## 1. An unknown GUC name aborts the whole transaction

```
BEGIN;
SELECT set_config('made_up_guc_name_zz', '1000', true);
-- ERROR:  unrecognized configuration parameter "made_up_guc_name_zz"
SELECT 1;
-- ERROR:  current transaction is aborted, commands ignored until end of transaction block
```

**On PostgreSQL 16, `transaction_timeout` is exactly such a name.** An unguarded
`set_config('transaction_timeout', …)` does not fail softly there; it kills the
transaction. Team 3's YR3-M1 is a real defect, not a theoretical one.

## 2. A PL/pgSQL `IF` guard is sufficient

A function whose unknown-GUC `set_config` sits inside `IF p THEN … END IF`:

- `p = false` → no error; `statement_timeout` is set to `5s` and is still `5s`
  after the call.
- `p = true` → `ERROR: unrecognized configuration parameter`.

PL/pgSQL does not validate the unselected branch. The shape teams 3 and 4 chose
works.

## 3. `transaction_timeout` 0 → positive **inside** an open transaction does arm

```
BEGIN;
SELECT set_config('transaction_timeout', '2000', true);
SELECT pg_sleep(4);
-- FATAL:  terminating connection due to transaction timeout
```

r12 said this was impossible. It is not. r13 is correct, and this is now an
execution rather than a reading of `assign_transaction_timeout`.

## 4. positive → positive does **not** re-arm, and the inherited value wins

```
SET transaction_timeout = '20000';
BEGIN;
SELECT set_config('transaction_timeout', '2000', true);  -- current_setting says 2s
SELECT pg_sleep(4);                                      -- survives
```

`current_setting` reports our value while the timer still holds the inherited
one. **An inherited value ends later than the one we set, never earlier.** Team 7's
`xact.c` reading is confirmed; the "earlier or equal, never later" wording that
teams 4 and 7 both carried was backwards.

## 5. Neutralisation works

```
SET transaction_timeout = '20000';
BEGIN;
SELECT set_config('transaction_timeout', '0', true);
SELECT set_config('transaction_timeout', '2000', true);
SELECT pg_sleep(4);
-- FATAL:  terminating connection due to transaction timeout
```

Team 3's revision 16 shape — zero first, then ours — does what it claims.

## 6. A function `SET` clause reverts **only the variables it names**

| function | after the call |
|---|---|
| `SET search_path = pg_catalog`, sets `statement_timeout` inside | **`7s` survives** |
| `SECURITY DEFINER`, no `SET` clause | **`7s` survives** |
| `SECURITY DEFINER` + `SET search_path` | **`7s` survives** |
| `SET statement_timeout = '1000'`, sets `statement_timeout` inside | **reverts to the pre-call value** |
| `SET transaction_timeout = '9000'`, sets `transaction_timeout` inside | **reverts to `0`; the timer never fires; nothing is raised** |

So the danger is real and silent, but **narrower than three designs state it**: the
arming function must not name `statement_timeout`,
`idle_in_transaction_session_timeout` or `transaction_timeout` in its own `SET`
clause. An unrelated `SET search_path` is harmless.

`proconfig IS NULL` is therefore **sufficient but stricter than necessary** — fine
as a defensive rule, but the stated reason ("any `SET` clause reverts our
settings") is wrong and should be corrected.

**Team 4's open question is answered: `SECURITY DEFINER` alone does _not_ revert
the settings.** It declined to assert this; the answer is no.

## 7. `statement_timeout` is disabled while `transaction_timeout` is smaller

| settings | `pg_sleep(5)` result |
|---|---|
| `statement_timeout = 3000`, `transaction_timeout = 2000` | `FATAL: terminating connection due to transaction timeout` |
| `statement_timeout = 2000`, `transaction_timeout = 8000` | `ERROR: canceling statement due to statement timeout` |
| `statement_timeout = 2000` alone | `ERROR: canceling statement due to statement timeout` |

The ordering trap r13 names is real: set `transaction_timeout` at or below
`statement_timeout` and the per-statement bound stops firing. Note the two endings
differ in kind — the transaction timeout **terminates the connection**, the
statement timeout only cancels the statement.

## 8. An `EXCEPTION` block reverts a transaction-local `set_config`

Observed while debugging a probe: a function containing `EXCEPTION WHEN others`
whose body raised after calling `set_config('statement_timeout','5000',true)`
left `statement_timeout` at `0` — the handler's subtransaction rollback took the
setting with it. Team 3's "no `EXCEPTION` clause, so no subtransaction" is
load-bearing, not stylistic.

## What this does not establish

- **PostgreSQL 16 was not run.** Item 1 is a proxy: on 17, `transaction_timeout`
  exists, so an unknown name was used to reproduce what 16 sees. Running a real 16
  would still be worth doing.
- **Prisma is not in the picture.** These were plain `psql` sessions. Whether each
  Prisma round trip gets a fresh statement timer, and how the extended protocol
  interacts, is untested here.
- **This is not the production server**, whose version and inherited
  `transaction_timeout` remain unknown to the repository.

---

## 9. The SQLSTATE of an unknown GUC name is `42704`

```
DO $$ BEGIN PERFORM set_config('made_up_guc_zz','1',true);
EXCEPTION WHEN others THEN RAISE NOTICE 'SQLSTATE=% MSG=%', SQLSTATE, SQLERRM; END $$;
-- NOTICE:  SQLSTATE=42704 MSG=unrecognized configuration parameter "made_up_guc_zz"
```

`42704` is `undefined_object`. A handler may catch it by name.

## 10. An `EXCEPTION` block keeps its settings on success and loses them on failure

| path | `statement_timeout` after the call | outer transaction |
|---|---|---|
| body succeeds | **`5s` — the setting survives** | usable |
| body raises, handler returns | **`0` — the setting is gone** | **usable, not poisoned** |

Two things follow, and they point in opposite directions.

- **The `EXCEPTION`-block shim does protect the outer transaction on PostgreSQL 16.**
  The error is caught, and the caller can carry on.
- **But it takes every setting the function made before the failing statement with
  it.** A shim that sets `statement_timeout` first and then tries
  `transaction_timeout` loses *both* on 16 — the handler returns cleanly and the
  transaction proceeds with **no timeouts armed at all**, raising nothing.

A design using the `EXCEPTION`-block shape must therefore either set the three
timeouts in a separate call from the one that may fail, or use the `IF`-guard
shape, which never raises in the first place (§2 above).

## 11. An outer `set_config` survives a caught error inside the same statement

The question §10 left open: if one statement both sets a GUC at the outer level
and calls a function whose body raises and is caught by its own handler, does the
outer setting survive the handler's subtransaction rollback?

```
BEGIN;
SELECT set_config('statement_timeout','0',true);
SELECT set_config('statement_timeout','5000',true), f_raises_caught();
SELECT current_setting('statement_timeout');   -- 5s
```

**It survives**, and the order in the select list makes no difference — calling the
function first gives the same `5s`.

So §10's loss is scoped to settings made **inside** the function that raises. A
statement that arms `statement_timeout` and `idle_in_transaction_session_timeout`
at the outer level, and only attempts `transaction_timeout` inside a function with
an `EXCEPTION` handler, keeps the two outer timeouts on PostgreSQL 16 and loses
only the one that does not exist there anyway.

**This corrects an assertion the coordinating session made to team 2**: that
revision 11's shim "loses both on 16". It does not. The `IF`-guard shape is still
preferable — it never raises, so there is no subtransaction at all — but the
defect claimed was not the defect present, and team 2 was right to refuse to
restate it as fact.

## 12. A read-back **after** the call detects the `SET`-clause trap; a value returned from inside it does not

The question left open when §6 was written: if a function carries
`SET transaction_timeout` and sets that same GUC inside, does anything observable
reveal that the timer never armed?

| observation point | trapped function (`SET transaction_timeout='9000'`) | ordinary function (no `SET` clause) |
|---|---|---|
| value **returned from inside** the function | `2s` | `2s` |
| `current_setting` read **after** the call | **`0`** | `2s` |

So the two are indistinguishable from inside and plainly different from outside.

- A shim that **returns a flag or the value it just set** cannot detect the trap —
  it reports success either way. Team 6's boolean return is this case.
- A **read-back in a later statement** does detect it, and needs no catalogue
  query.

That makes the `pg_proc.proconfig IS NULL` catalogue assertion a **second**
instrument rather than the only one, which is what teams 6 and 7 were each asking.
Both remain reasonable — the catalogue assertion fails the build, the read-back
fails the run — but a design should stop claiming the catalogue check is the sole
possible detection.
