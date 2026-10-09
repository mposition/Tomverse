/**
 * The numbers §12 (1) of `docs/policy/trust-safety-compliance-agent.md` puts up
 * for signature, read out of that document and checked against the derivations
 * it states for them.
 *
 * ## Why this exists
 *
 * §14's stage 1 entry conditions require the merge of "§12 (1)의 표를 출처로
 * 읽는 테스트" -- a test that reads those tables as its source. This is the
 * parser behind it. Until there is runtime code to compare them against, what
 * the test can do is the thing worth doing first: **check that the arithmetic
 * the document claims actually holds**, so the operator signs numbers that have
 * been verified rather than numbers that merely look consistent.
 *
 * That is not hypothetical. §12 records two places where an earlier revision
 * had the table and the test carrying different formulas for the same quantity
 * -- one giving 24s and 9s, the other 21s and 6s. Nothing caught it, because
 * nothing read the table.
 *
 * ## What it does not do
 *
 * It does not approve, propose or change a number. §12's tables are the only
 * source, and the signature is the operator's: an agent that edited them would
 * be approving its own policy. It reads, and it says whether what is written is
 * self-consistent.
 *
 * It also checks only the derivations **the document states**. Inventing a
 * relation the policy does not claim would make this file a second source, and
 * §12 says there is one.
 *
 * ## Pure
 *
 * No filesystem, no clock. The document's text comes in; findings go out.
 */

/** Reads a number out of a table cell: `**15초**`, `20,000ms`, `30분`, `90일`. */
const numberIn = (cell) => {
  if (cell === undefined) return undefined;
  const match = /(-?[0-9][0-9,]*)/.exec(String(cell).replace(/\*\*/g, ""));
  if (!match) return undefined;
  return Number(match[1].replace(/,/g, ""));
};

/** The rows of the markdown table whose header row matches. */
const tableRows = (text, headerPattern) => {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^\|/.test(line) && headerPattern.test(line));
  if (start < 0) return undefined;
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\|/.test(line)) break;
    if (/^\|\s*-+/.test(line)) continue;
    rows.push(
      line
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows.length > 0 ? rows : undefined;
};

const rowNamed = (rows, pattern) => rows?.find((row) => pattern.test(row[0]));

/**
 * The three tables, or `undefined` for one that could not be found.
 *
 * A table that cannot be read is reported as missing rather than as an empty
 * set of numbers. An empty set passes every check there is.
 */
export const parsePolicyNumbers = (text) => {
  const aRows = tableRows(text, /이름\s*\|\s*제안값\s*\|\s*유도와 범위/);
  const bRows = tableRows(text, /종류\s*\|\s*`A`\s*\|\s*`R`/);
  const cRows = tableRows(text, /이름\s*\|\s*제안값\s*\|\s*유도\s*\|/);

  const tableA = aRows
    ? {
        declarationPeriodMinutes: numberIn(rowNamed(aRows, /선언 주기/)?.[1]),
        deadManMultiplier: numberIn(rowNamed(aRows, /창 배수/)?.[1]),
        deadManWindowMinutes: numberIn(
          /=\s*\*\*(\d+)분\*\*/.exec(rowNamed(aRows, /창 배수/)?.[2] ?? "")?.[0],
        ),
        pingUrlRotationDays: numberIn(rowNamed(aRows, /회전 주기/)?.[1]),
        runRowRetentionDays: numberIn(rowNamed(aRows, /보존 기간/)?.[1]),
      }
    : undefined;

  const tableB = bRows
    ? bRows.map((row) => ({
        kind: row[0].replace(/\*\*/g, "").trim(),
        a: numberIn(row[1]),
        r: numberIn(row[2]),
        guardedSeconds: numberIn(row[3]),
        transactionTimeoutSeconds: numberIn(row[4]),
        prismaTimeoutMs: numberIn(row[5]),
      }))
    : undefined;

  const tableC = cRows
    ? {
        activationWriteDeadlineSeconds: numberIn(rowNamed(cRows, /activation 쓰기의 마감/)?.[1]),
        runRowDeadlineSeconds: numberIn(rowNamed(cRows, /회차 행의 마감/)?.[1]),
        roundWindowSeconds: numberIn(rowNamed(cRows, /회차 창/)?.[1]),
        guardedTotalSeconds: numberIn(rowNamed(cRows, /guarded 합계/)?.[1]),
        routeBudgetSeconds: numberIn(rowNamed(cRows, /route 예산/)?.[1]),
        monotonicPreCheckMs: numberIn(rowNamed(cRows, /단조 시계 사전 검사/)?.[1]),
        pingAbortSeconds: numberIn(rowNamed(cRows, /ping 전송/)?.[1]),
        pingFreshnessSeconds: numberIn(rowNamed(cRows, /ping 신선도 예산/)?.[1]),
        childTimeoutSeconds: numberIn(rowNamed(cRows, /child 요청 timeout/)?.[1]),
        supervisorKillSeconds: numberIn(rowNamed(cRows, /supervisor 강제 종료/)?.[1]),
      }
    : undefined;

  return { tableA, tableB, tableC };
};

/** The per-statement guard §12 table B fixes for every kind, in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 2_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 1_000;

const kindOf = (tableB, pattern) => tableB?.find((row) => pattern.test(row.kind));

/**
 * Every derivation §12 states, each with the quantity it comes from.
 *
 * A finding carries the claim rather than only a boolean, so a failure names
 * what the document says and what its own numbers give.
 */
export const checkDerivations = (parsed) => {
  const findings = [];
  const claim = (name, stated, derived, from) =>
    findings.push({
      name,
      stated,
      derived,
      from,
      ok: stated !== undefined && derived !== undefined && stated === derived,
      readable: stated !== undefined && derived !== undefined,
    });

  const { tableA, tableB, tableC } = parsed ?? {};

  if (tableA) {
    // `W = k × P`, the one derivation table A states.
    claim(
      "dead-man window W",
      tableA.deadManWindowMinutes,
      tableA.deadManMultiplier !== undefined && tableA.declarationPeriodMinutes !== undefined
        ? tableA.deadManMultiplier * tableA.declarationPeriodMinutes
        : undefined,
      "k × P",
    );
  }

  for (const row of tableB ?? []) {
    // `R = A + 2`, adding BEGIN and COMMIT.
    claim(`${row.kind}: R`, row.r, row.a !== undefined ? row.a + 2 : undefined, "A + 2");
    // `C_guarded = A × 2,000 + A × 1,000`, stated in milliseconds and tabulated
    // in seconds.
    claim(
      `${row.kind}: C_guarded`,
      row.guardedSeconds,
      row.a !== undefined
        ? (row.a * STATEMENT_TIMEOUT_MS + row.a * IDLE_IN_TRANSACTION_TIMEOUT_MS) / 1000
        : undefined,
      "(A × 2,000 + A × 1,000) ms",
    );
    // `transaction_timeout = C_guarded + 3초`.
    claim(
      `${row.kind}: transaction_timeout`,
      row.transactionTimeoutSeconds,
      row.guardedSeconds !== undefined ? row.guardedSeconds + 3 : undefined,
      "C_guarded + 3s",
    );
  }

  const t0 = kindOf(tableB, /^T0/);
  const ta = kindOf(tableB, /^Ta/);
  const tr = kindOf(tableB, /^Tr/);
  const human = kindOf(tableB, /activation 쓰기/);

  if (tableC) {
    // §12 corrects an earlier revision here: a deadline is that kind's
    // C_guarded, not (A − 1) × 3s.
    claim(
      "activation write deadline",
      tableC.activationWriteDeadlineSeconds,
      human?.guardedSeconds,
      "the human kind's C_guarded",
    );
    claim("run row deadline", tableC.runRowDeadlineSeconds, tr?.guardedSeconds, "Tr's C_guarded");
    claim(
      "guarded total",
      tableC.guardedTotalSeconds,
      t0?.guardedSeconds !== undefined &&
        ta?.guardedSeconds !== undefined &&
        tr?.guardedSeconds !== undefined &&
        tableC.pingAbortSeconds !== undefined
        ? t0.guardedSeconds + ta.guardedSeconds + tr.guardedSeconds + tableC.pingAbortSeconds
        : undefined,
      "T0 + Ta + Tr + ping",
    );
    claim(
      "route budget B",
      tableC.routeBudgetSeconds,
      tableC.roundWindowSeconds !== undefined &&
        tr?.guardedSeconds !== undefined &&
        tableC.pingAbortSeconds !== undefined
        ? tableC.roundWindowSeconds + tr.guardedSeconds + tableC.pingAbortSeconds
        : undefined,
      "round window + Tr's C_guarded + ping",
    );
    claim(
      "ping freshness budget",
      tableC.pingFreshnessSeconds,
      tableC.roundWindowSeconds !== undefined &&
        tableC.monotonicPreCheckMs !== undefined &&
        tableC.pingAbortSeconds !== undefined
        ? tableC.roundWindowSeconds + tableC.monotonicPreCheckMs / 1000 + tableC.pingAbortSeconds
        : undefined,
      "round window + monotonic pre-check + ping",
    );
    claim(
      "child request timeout",
      tableC.childTimeoutSeconds,
      tableC.routeBudgetSeconds !== undefined ? tableC.routeBudgetSeconds + 10 : undefined,
      "B + 10s",
    );
    claim(
      "supervisor kill",
      tableC.supervisorKillSeconds,
      tableC.childTimeoutSeconds !== undefined ? tableC.childTimeoutSeconds + 30 : undefined,
      "child + 30s",
    );
  }

  return findings;
};

/**
 * The orderings §12 states as a contract in its own right, beside the
 * equalities.
 *
 * A review found this absent and gave the counterexample: move `P` to 5
 * minutes and scale the round window, `B`, the child timeout and the
 * supervisor kill consistently, and **every derivation and bound still holds
 * while the supervisor outlives the declaration period** -- two runs overlap,
 * and §8's dead-man reasoning rests on them not doing so. An equality check
 * cannot see that, because nothing was made unequal.
 *
 * §12 states three things here:
 *
 *  - per row, `Prisma timeout` > `transaction_timeout` > `C_guarded` >
 *    `statement_timeout` > `idle`;
 *  - outside, guarded total < route budget < child < supervisor < `P`, with
 *    the outer two gaps being 10s and 30s;
 *  - and `transaction_timeout` > `statement_timeout` **asserted separately**,
 *    because at or below it PostgreSQL 17 never reaches the statement guard.
 */
export const checkOrderings = (parsed) => {
  const { tableA, tableB, tableC } = parsed ?? {};
  const orderings = [];
  const chain = (name, steps) => {
    const values = steps.map((step) => step.value);
    const readable = values.every((value) => typeof value === "number");
    orderings.push({
      name,
      ok: readable ? values.every((value, i) => i === 0 || values[i - 1] > value) : undefined,
      because: readable
        ? steps.map((step) => `${step.label} ${step.value}`).join(" > ")
        : "a value in this chain could not be read",
    });
  };

  for (const row of tableB ?? []) {
    chain(`${row.kind}: the five values in order`, [
      { label: "Prisma", value: row.prismaTimeoutMs },
      { label: "transaction_timeout", value: row.transactionTimeoutSeconds * 1000 },
      { label: "C_guarded", value: row.guardedSeconds * 1000 },
      { label: "statement_timeout", value: STATEMENT_TIMEOUT_MS },
      { label: "idle_in_transaction", value: IDLE_IN_TRANSACTION_TIMEOUT_MS },
    ]);
    // §12 asks for this one on its own: at or below the statement guard,
    // PostgreSQL 17 ends the transaction before any statement can be cut off.
    orderings.push({
      name: `${row.kind}: transaction_timeout above statement_timeout`,
      ok:
        typeof row.transactionTimeoutSeconds === "number"
          ? row.transactionTimeoutSeconds * 1000 > STATEMENT_TIMEOUT_MS
          : undefined,
      because:
        typeof row.transactionTimeoutSeconds === "number"
          ? `${row.transactionTimeoutSeconds * 1000}ms against ${STATEMENT_TIMEOUT_MS}ms`
          : "transaction_timeout could not be read",
    });
  }

  if (tableC && tableA) {
    // Outermost: the supervisor must die before the next declaration starts,
    // or two runs overlap.
    chain("the outer budgets in order", [
      { label: "P", value: tableA.declarationPeriodMinutes * 60 },
      { label: "supervisor", value: tableC.supervisorKillSeconds },
      { label: "child", value: tableC.childTimeoutSeconds },
      { label: "route budget B", value: tableC.routeBudgetSeconds },
      { label: "guarded total", value: tableC.guardedTotalSeconds },
    ]);
    const gap = (name, larger, smaller, expected) =>
      orderings.push({
        name,
        ok:
          typeof larger === "number" && typeof smaller === "number"
            ? larger - smaller === expected
            : undefined,
        because:
          typeof larger === "number" && typeof smaller === "number"
            ? `${larger} - ${smaller} = ${larger - smaller}, stated ${expected}`
            : "a value in this gap could not be read",
      });
    gap("the child gap is 10s", tableC.childTimeoutSeconds, tableC.routeBudgetSeconds, 10);
    gap("the supervisor gap is 30s", tableC.supervisorKillSeconds, tableC.childTimeoutSeconds, 30);
  }

  return orderings;
};

/**
 * The bounds §12 states as ranges rather than equalities. A bound that holds is
 * not a derivation, so these are reported apart from the equalities above.
 */
export const checkBounds = (parsed) => {
  const { tableA, tableB, tableC } = parsed ?? {};
  const bounds = [];
  const bound = (name, ok, because) => bounds.push({ name, ok, because });

  if (tableA?.declarationPeriodMinutes !== undefined) {
    bound(
      "declaration period P within 5-59",
      tableA.declarationPeriodMinutes >= 5 && tableA.declarationPeriodMinutes <= 59,
      `P = ${tableA.declarationPeriodMinutes}`,
    );
  }

  const t0 = kindOf(tableB, /^T0/);
  const ta = kindOf(tableB, /^Ta/);
  const tr = kindOf(tableB, /^Tr/);
  if (
    tableC?.roundWindowSeconds !== undefined &&
    t0?.guardedSeconds !== undefined &&
    ta?.guardedSeconds !== undefined &&
    tr?.guardedSeconds !== undefined
  ) {
    // The floor is derived even though the value above it is a free proposal:
    // T0 + Ta + Tr + 1s for the monotonic read.
    const floor = t0.guardedSeconds + ta.guardedSeconds + tr.guardedSeconds + 1;
    bound(
      "round window at or above its derived floor",
      tableC.roundWindowSeconds >= floor,
      `${tableC.roundWindowSeconds}s against a floor of ${floor}s`,
    );
  }

  for (const row of tableB ?? []) {
    if (row.prismaTimeoutMs === undefined || row.transactionTimeoutSeconds === undefined) continue;
    // Prisma's interactive-transaction timeout has to outlast the database's
    // own, or the client gives up on a transaction the database still allows.
    bound(
      `${row.kind}: Prisma timeout above transaction_timeout`,
      row.prismaTimeoutMs > row.transactionTimeoutSeconds * 1000,
      `${row.prismaTimeoutMs}ms against ${row.transactionTimeoutSeconds * 1000}ms`,
    );
  }

  return bounds;
};

/**
 * §12 says Ta and Tr must stay separate rows even while they carry the same
 * numbers, so that a statement added to Tr cannot drag Ta along. Equal values
 * are expected; one row standing for both is the thing to refuse.
 */
export const checkTaTrSeparate = (parsed) => {
  const rows = parsed?.tableB ?? [];
  const ta = rows.filter((row) => /^Ta/.test(row.kind));
  const tr = rows.filter((row) => /^Tr/.test(row.kind));
  return {
    separate: ta.length === 1 && tr.length === 1,
    sameNumbers:
      ta[0]?.a === tr[0]?.a &&
      ta[0]?.guardedSeconds === tr[0]?.guardedSeconds &&
      ta[0]?.transactionTimeoutSeconds === tr[0]?.transactionTimeoutSeconds,
  };
};
