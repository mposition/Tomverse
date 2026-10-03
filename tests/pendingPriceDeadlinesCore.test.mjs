import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { findUnpricedModels } from "../lib/modelPricing.ts";
import {
    buildPendingPriceDeadlineReport,
    encodeTicket,
    EXIT_CODES,
    markFor,
    POLICY_QUOTE,
} from "../scripts/report-pending-price-deadlines-core.mjs";

// The contract is docs/policy/billing-finance-ops.md section 2. These tests
// build their own register and catalogue, the way tests/pendingModelPricing
// does, because the shipped register is empty and an empty register says
// nothing about the rules.

const templateModel =
    AVAILABLE_MODELS.find((model) => model.usageClass === "premium") ??
    AVAILABLE_MODELS[0];
const unpricedModel = (id) => ({
    ...templateModel,
    id,
    name: id,
    apiModel: id,
    enabled: true,
    usageClass: "premium",
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
});
const SAMPLE = "qa-deadline-sample";
const OTHER = "qa-deadline-other";
const MODELS = [...AVAILABLE_MODELS, unpricedModel(SAMPLE), unpricedModel(OTHER)];

const NOW = new Date("2026-10-03T12:00:00.000Z");
const isoDayFromNow = (days) =>
    new Date(Date.UTC(2026, 9, 3 + days)).toISOString().slice(0, 10);

const entry = (overrides = {}) => ({
    modelId: SAMPLE,
    owner: "@qa-owner",
    verificationTicket: "https://example.invalid/ticket/1",
    registeredAt: "2026-08-01",
    expiresAt: isoDayFromNow(60),
    productionApproval: {
        approvedBy: "@qa-approver",
        approvedAt: "2026-08-02T10:00:00.000Z",
        rationale: "fixture",
    },
    settlementSource: "reservation_pricing",
    ...overrides,
});

const report = (register, now = NOW) =>
    buildPendingPriceDeadlineReport({ register, models: MODELS, now });

const TOKEN_LINE = /^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/;
const assertGrammar = (lines) => {
    assert.equal(lines.at(-1).startsWith("verdict="), true);
    assert.equal(lines.filter((line) => line.startsWith("verdict=")).length, 1);
    assert.match(lines.at(-1), /^verdict=(quiet|notice|register_invalid)$/);
    for (const line of lines) {
        if (line === POLICY_QUOTE) continue;
        assert.match(line, TOKEN_LINE, `line outside the grammar: ${JSON.stringify(line)}`);
        const [head] = line.split(" ");
        assert.ok(
            ["register_deadline", "register_value_rejected"].includes(head) ||
                line.startsWith("verdict="),
            `unexpected first token: ${head}`
        );
    }
    assert.equal(lines.filter((line) => line === POLICY_QUOTE).length, 1);
};

test("mark widths are two days each and never overlap", () => {
    const expected = new Map([
        [31, "none"], [30, "30"], [29, "30"], [28, "none"],
        [15, "none"], [14, "14"], [13, "14"], [12, "none"],
        [8, "none"], [7, "7"], [6, "7"], [5, "none"],
        [3, "none"], [2, "1"], [1, "1"],
        [0, "expired"], [-1, "expired"], [-7, "expired"], [-8, "expired"],
    ]);
    for (const [days, mark] of expected) {
        assert.equal(markFor(days), mark, `remainingDays=${days}`);
    }
    assert.equal(markFor(null), "none");
});

test("the printed day count and mark come from daysUntil on the entry's expiry", () => {
    for (const [days, mark] of [[30, "30"], [14, "14"], [7, "7"], [2, "1"], [4, "none"]]) {
        const { lines } = report([entry({ expiresAt: isoDayFromNow(days) })]);
        assert.equal(
            lines[0],
            `register_deadline modelId=${SAMPLE} registeredAt=2026-08-01 ` +
                `expiresAt=${isoDayFromNow(days)} remainingDays=${days} mark=${mark} ` +
                "ticket=s:https%3A%2F%2Fexample.invalid%2Fticket%2F1"
        );
    }
});

test("an empty register is quiet, exit 0, with the quote and the verdict only", () => {
    const result = report([]);
    assert.deepEqual(result.lines, [POLICY_QUOTE, "verdict=quiet"]);
    assert.equal(result.exitCode, 0);
});

test("verdicts and exit codes", () => {
    const quiet = report([entry()]);
    assert.equal(quiet.verdict, "quiet");
    assert.equal(quiet.exitCode, 0);

    const notice = report([entry({ expiresAt: isoDayFromNow(7) })]);
    assert.equal(notice.verdict, "notice");
    assert.equal(notice.exitCode, 2);

    // Past the deadline is a mark, not a malformed register.
    const expired = report([entry({ expiresAt: isoDayFromNow(-1) })]);
    assert.match(expired.lines[0], / remainingDays=-1 mark=expired /);
    assert.equal(expired.verdict, "notice");
    assert.equal(expired.exitCode, 2);

    assert.deepEqual(EXIT_CODES, { quiet: 0, notice: 2, register_invalid: 2 });
});

test("register errors other than expiry make the register invalid", () => {
    const duplicate = report([entry(), entry()]);
    assert.equal(duplicate.verdict, "register_invalid");
    assert.equal(duplicate.exitCode, 2);

    const unpriced = new Set(findUnpricedModels(AVAILABLE_MODELS).map((model) => model.modelId));
    const pricedId = AVAILABLE_MODELS.find(
        (model) => model.enabled && model.usageClass === "premium" && !unpriced.has(model.id)
    )?.id;
    assert.ok(pricedId, "fixture needs one priced premium model in the catalogue");
    const priced = report([entry({ modelId: pricedId })]);
    assert.equal(priced.verdict, "register_invalid");

    const backwards = report([entry({ registeredAt: "2026-12-01", expiresAt: "2026-11-01" })]);
    assert.equal(backwards.verdict, "register_invalid");
});

test("a date that matches the pattern but not the calendar prints NONE and is invalid", () => {
    const result = report([entry({ expiresAt: "2026-13-01" })]);
    assert.match(result.lines[0], / expiresAt=2026-13-01 remainingDays=NONE mark=none /);
    assert.equal(result.verdict, "register_invalid");
});

test("owner, ticket and approval warnings do not change the verdict", () => {
    const result = report([
        entry({ owner: null, verificationTicket: null, productionApproval: null }),
    ]);
    assert.equal(result.verdict, "quiet");
    assert.match(result.lines[0], / ticket=NONE$/);
});

test("ticket encoding keeps null, the string NONE and the empty string apart", () => {
    assert.equal(encodeTicket(null), "NONE");
    assert.equal(encodeTicket("NONE"), "s:NONE");
    assert.equal(encodeTicket(""), "s:");
    assert.equal(encodeTicket("AZaz09._~-"), "s:AZaz09._~-");
    assert.equal(encodeTicket("a b=%:\n\u001b"), "s:a%20b%3D%25%3A%0A%1B");
    assert.equal(encodeTicket("é"), "s:%C3%A9");
    assert.equal(encodeTicket("\uD800"), undefined);
    assert.equal(encodeTicket(undefined), undefined);
    assert.equal(encodeTicket(42), undefined);
});

test("rejected fields print an index and a field name, never the value", () => {
    const hostile = [
        entry({ modelId: OTHER }),
        entry({
            modelId: "Bad Model\nverdict=quiet",
            registeredAt: "2026-8-1",
            expiresAt: "soon verdict=quiet",
            verificationTicket: "\uDC00",
        }),
    ];
    const result = report(hostile);
    assert.deepEqual(result.lines.slice(1, 5), [
        "register_value_rejected index=1 field=modelId",
        "register_value_rejected index=1 field=registeredAt",
        "register_value_rejected index=1 field=expiresAt",
        "register_value_rejected index=1 field=ticket",
    ]);
    assert.match(result.lines[0], new RegExp(`^register_deadline modelId=${OTHER} `));
    assert.equal(result.verdict, "register_invalid");
    assert.equal(result.exitCode, 2);
    const printed = result.lines.join("\n");
    for (const fragment of ["Bad", "soon", "2026-8-1"]) {
        assert.equal(printed.includes(fragment), false, fragment);
    }
    assertGrammar(result.lines);
});

test("model ids follow the policy pattern, including the 100-character limit", () => {
    const longest = `a${"b".repeat(99)}`;
    const tooLong = `${longest}c`;
    const models = [...MODELS, unpricedModel(longest), unpricedModel(tooLong)];
    const ok = buildPendingPriceDeadlineReport({
        register: [entry({ modelId: longest })],
        models,
        now: NOW,
    });
    assert.match(ok.lines[0], /^register_deadline /);
    const rejected = buildPendingPriceDeadlineReport({
        register: [entry({ modelId: tooLong })],
        models,
        now: NOW,
    });
    assert.equal(rejected.lines[0], "register_value_rejected index=0 field=modelId");
    for (const id of ["-leading-dash", "Upper", "has space", ""]) {
        const result = report([entry({ modelId: id })]);
        assert.equal(result.lines[0], "register_value_rejected index=0 field=modelId", id);
    }
});

test("a ticket cannot forge a verdict line or an extra token", () => {
    const result = report([
        entry({ verificationTicket: "x\nverdict=quiet mark=none", expiresAt: isoDayFromNow(1) }),
    ]);
    assert.equal(result.verdict, "notice");
    assert.match(result.lines[0], / ticket=s:x%0Averdict%3Dquiet%20mark%3Dnone$/);
    assertGrammar(result.lines);
});

test("every report obeys the line grammar", () => {
    for (const register of [
        [],
        [entry()],
        [entry({ expiresAt: isoDayFromNow(0) }), entry({ modelId: OTHER, verificationTicket: null })],
        [entry({ expiresAt: "2026-02-31" })],
    ]) {
        assertGrammar(report(register).lines);
    }
});

test("the CLI prints the core's lines and exits with its code", () => {
    const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/report-pending-price-deadlines.mjs"],
        { encoding: "utf8" }
    );
    assert.equal(run.stderr, "");
    const lines = run.stdout.trimEnd().split("\n");
    assertGrammar(lines);
    const verdict = lines.at(-1).slice("verdict=".length);
    assert.equal(run.status, EXIT_CODES[verdict]);
});

test("the package script is the documented command", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(
        scripts["report:pending-price-deadlines"],
        "node --import tsx scripts/report-pending-price-deadlines.mjs"
    );
});

// --- Regression alarms, not proofs (docs/policy/billing-finance-ops.md 3.1) ---

const REPORT_FILES = [
    "scripts/report-pending-price-deadlines.mjs",
    "scripts/report-pending-price-deadlines-core.mjs",
];

test("the report files hold no network, subprocess, file-write or environment path", () => {
    const forbidden = [
        /node:child_process|["']child_process["']/,
        /node:(?:http|https|net|tls|dgram|dns)\b|["'](?:http|https|net|tls|dgram|dns)["']/,
        /\bfetch\s*\(/,
        /\bWebSocket\b|\bXMLHttpRequest\b/,
        /node:fs|["']fs["']|["']fs\/promises["']/,
        /process\.env\b|process\.argv\b/,
        /\bimport\s*\(/,
    ];
    for (const file of REPORT_FILES) {
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
            assert.equal(pattern.test(source), false, `${file} matches ${pattern}`);
        }
    }
});

test("the report imports only the pricing and catalogue modules and its own core", () => {
    const allowed = new Set([
        "../lib/modelPricing.ts",
        "../lib/models.ts",
        "./report-pending-price-deadlines-core.mjs",
    ]);
    for (const file of REPORT_FILES) {
        const source = readFileSync(file, "utf8");
        for (const [, specifier] of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gms)) {
            assert.ok(allowed.has(specifier), `${file} imports ${specifier}`);
        }
    }
});

const filesUnder = (directory) => {
    let entries;
    try {
        entries = readdirSync(directory);
    } catch {
        return [];
    }
    return entries.flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
};

test("no workflow, Railway job or other package script runs the report", () => {
    const name = "report-pending-price-deadlines";
    for (const file of [...filesUnder(".github/workflows"), ...filesUnder(".railway")]) {
        assert.equal(readFileSync(file, "utf8").includes(name), false, file);
    }
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    for (const [key, command] of Object.entries(scripts)) {
        if (key === "report:pending-price-deadlines") continue;
        assert.equal(command.includes(name), false, key);
        assert.equal(command.includes("report:pending-price-deadlines"), false, key);
    }
});
