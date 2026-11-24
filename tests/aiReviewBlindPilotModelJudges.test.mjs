import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadBundle, runModelJudges } from "../scripts/experiments/ai-review-blind-pilot.mjs";
import { PilotInputError, adjudicationTemplate, appearsIn, buildReport, freezeInputs, prepare, renderReport } from "../scripts/experiments/ai-review-blind-pilot/core.mjs";
import {
    adjudicateWithModels,
    antigravityJudgeAnswer,
    codexAnswer,
    engineFor,
    judgeWithModel,
    mergeAdjudications,
    reviewGoldWithModels,
    spawnEngine,
} from "../scripts/experiments/ai-review-blind-pilot/model-judges.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "experiments", "ai-review-blind-pilot", "fixtures");
const PLAN = path.join(fixtures, "plan-model-judges.json");
const T0 = "2026-11-24T00:00:00.000Z";
const loadFixture = () => structuredClone(loadBundle(PLAN));
const mockRows = JSON.parse(readFileSync(path.join(fixtures, "mock-judging.json"), "utf8")).outputs;
const section = (prompt, start, end) => JSON.parse(prompt.slice(prompt.indexOf(start) + start.length, prompt.indexOf(end)).trim());

/**
 * A stand-in for both CLIs: answers the gold review, the judging and the
 * adjudication from the synthetic mock fixture, so the flow can be checked
 * end to end without a model call. `tweak` edits one engine's answer.
 */
function fakeModels({ tweak = () => {} } = {}) {
    const bundle = loadFixture();
    const key = prepare(bundle, freezeInputs(bundle, T0)).key;
    const metaOf = (outputId) => key.outputs.find((output) => output.outputId === outputId);
    const rowsOf = (outputId) => mockRows[`${metaOf(outputId).slot}/${metaOf(outputId).caseId}`];
    const calls = [];
    const run = async (engine, prompt) => {
        calls.push({ engine: engine.id, prompt });
        let answer;
        if (prompt.startsWith("You review a candidate gold list")) {
            answer = { cases: Object.fromEntries(bundle.cases.cases.map((c) => [c.caseId, { ok: true, problems: [] }])) };
        } else if (prompt.startsWith("You are a blind judge")) {
            const outputs = section(prompt, "## Outputs to judge", "## Packet");
            answer = {
                outputs: outputs.map(({ outputId }) => ({
                    outputId,
                    rows: rowsOf(outputId).map((row) => ({ segment: row.segment, excerpt: row.excerpt ?? null, kind: row.kind, targets: row.targets, statement: row.statement, support: row.support ?? null, note: "" })),
                })),
            };
        } else if (prompt.startsWith("You adjudicate locked judge records")) {
            const sheet = section(prompt, "## Sheet", "## The packet the judges read");
            answer = { outputs: {} };
            for (const output of sheet) {
                const verdicts = rowsOf(output.outputId)
                    .map((row, index) => ({ row: index, kind: row.kind, verdict: row.verdict, goldId: row.goldId ?? null, sufficiency: row.sufficiency ?? "sufficient" }))
                    .filter((row) => ["contradiction", "missing", "document_error"].includes(row.kind));
                answer.outputs[output.outputId] = { judges: output.judges.map(() => verdicts), consensus: verdicts.map((v) => ({ judge: 0, ...v })) };
            }
        } else throw new Error("unexpected prompt");
        tweak(engine, prompt, answer);
        return { text: `Here is the result:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` };
    };
    return { run, calls, key };
}

async function withOut(fn) {
    const out = mkdtempSync(path.join(os.tmpdir(), "pilot-model-"));
    try {
        return await fn(out);
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}

test("two model judges run the whole flow and every step says it was a model", async () => {
    await withOut(async (out) => {
        const fake = fakeModels();
        const { report, files } = await runModelJudges(PLAN, out, { run: fake.run, now: () => T0 });
        // gold review x2, judge x2, adjudication x2
        assert.deepEqual(fake.calls.map((c) => c.engine), ["codex", "antigravity", "codex", "antigravity", "codex", "antigravity"]);
        assert.equal(report.provenance.goldReviewStatus, "model_reviewed");
        assert.deepEqual(report.provenance.model.steps, ["정답표 검토", "판정", "정답 대조"]);
        assert.equal(report.provenance.judgements.judging, "double");
        assert.ok(report.provenance.judgements.judges.every((judge) => judge.kind === "model" && judge.name.includes("사람 아님")));
        assert.equal(report.provenance.adjudication.state, "accepted");
        assert.equal(report.provenance.adjudication.disputes.length, 0);
        // Same rows from both judges: agreed before consensus on every double-judged output.
        assert.equal(report.agreement.agreedBeforeConsensus, report.agreement.doubleJudgedOutputs);
        // Same numbers as the single mock judge.
        const rate = (r) => [r.numerator, r.denominator];
        assert.deepEqual(rate(report.products.X.contradiction.precision), [3, 7]);
        assert.deepEqual(rate(report.products.Y.contradiction.recall), [2, 3]);
        // Synthetic outputs keep the result unmeasured; the model steps are listed too.
        assert.equal(report.products.X.measurement.status, "unmeasured");
        assert.deepEqual(report.products.X.measurement.modelSteps, ["정답표 검토", "판정", "정답 대조"]);
        const md = readFileSync(files.reportMd, "utf8");
        assert.match(md, /모델 둘의 검토 통과 \(사람 검토 아님\)/);
        assert.match(md, /모델이 사람 대신 한 단계/);
        const record = JSON.parse(readFileSync(files.record(2), "utf8"));
        assert.equal(record.status, "locked");
        assert.deepEqual(record.judge, { name: "Antigravity 모델 판정자 (사람 아님)", kind: "model", engine: "antigravity", vendor: "google", model: "gemini-4-hydrogen-high" });
    });
});

test("a judge prompt carries only the blinded packet, and a leak stops the call", async () => {
    const fake = fakeModels();
    const bundle = loadFixture();
    const prepared = prepare(bundle, freezeInputs(bundle, T0));
    const engine = engineFor("codex", { call: { run: fake.run } });
    await judgeWithModel(prepared, 1, engine, { at: T0 });
    const [call] = fake.calls;
    assert.deepEqual(prepared.terms.filter((term) => appearsIn(term, call.prompt)), []);
    assert.ok(!call.prompt.includes("qp-g-"), "no gold id reaches a judge");

    const leaked = structuredClone(prepared);
    leaked.packets[0].markdown += "\nTomverse";
    const before = fake.calls.length;
    await assert.rejects(() => judgeWithModel(leaked, 1, engine, { at: T0 }), PilotInputError);
    assert.equal(fake.calls.length, before, "no model call after a leak");
});

test("a malformed answer is asked once more with its problems; a refused run is not retried", async () => {
    const bundle = loadFixture();
    const prepared = prepare(bundle, freezeInputs(bundle, T0));
    const fake = fakeModels();
    let first = true;
    const flaky = async (engine, prompt) => {
        if (first) {
            first = false;
            return { text: '{"outputs":[]}' };
        }
        return fake.run(engine, prompt);
    };
    const prompts = [];
    const record = await judgeWithModel(prepared, 1, engineFor("codex", { call: { run: (e, p) => (prompts.push(p), flaky(e, p)) } }), { at: T0 });
    assert.equal(record.status, "locked");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Your previous answer was rejected/);

    let calls = 0;
    const refused = engineFor("antigravity", { call: { run: async () => (calls += 1, { reason: "antigravity_tool_refused" }) } });
    await assert.rejects(() => judgeWithModel(prepared, 1, refused, { at: T0 }), /antigravity_tool_refused/);
    assert.equal(calls, 1);
});

test("adjudicators that disagree leave the row undetermined and the output for a person", async () => {
    await withOut(async (out) => {
        let target = null;
        const fake = fakeModels({
            tweak: (engine, prompt, answer) => {
                if (engine.id !== "antigravity" || !prompt.startsWith("You adjudicate")) return;
                // Antigravity calls X's false 14-day finding a match instead.
                target = Object.keys(answer.outputs).find((id) => fake.key.outputs.find((o) => o.outputId === id)?.caseId === "qp-notice-2-ko" && fake.key.outputs.find((o) => o.outputId === id).slot === "X");
                answer.outputs[target].judges[0][0] = { row: 0, verdict: "matched", goldId: "qp-g-notice-1-ko-c1", sufficiency: "sufficient" };
                answer.outputs[target].consensus = [];
            },
        });
        // A gold id from another case is refused as an answer, so the tweak is asked again;
        // give the retry the same disagreement in a valid form.
        const run = async (engine, prompt) => {
            const answer = await fake.run(engine, prompt);
            if (engine.id === "antigravity" && prompt.startsWith("You adjudicate") && prompt.includes("Your previous answer was rejected")) {
                const body = JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1));
                for (const rows of body.outputs[target].judges) rows[0] = { row: 0, verdict: "gold_gap", goldId: null, sufficiency: "sufficient" };
                return { text: JSON.stringify(body) };
            }
            return answer;
        };
        const { report } = await runModelJudges(PLAN, out, { run, now: () => T0 });
        const disputes = report.provenance.adjudication.disputes;
        assert.equal(disputes.length, 3, "row ruling for each judge + consensus");
        const output = report.outputs.find((o) => o.outputId === target);
        assert.equal(output.state, "adjudication_disputed");
        assert.match(renderReport(report), /사람 확인 필요/);
    });
});

test("merge keeps only verdicts both adjudicators gave", () => {
    const template = {
        outputs: {
            "O-1": {
                caseLabel: "사례 1",
                gold: {},
                judges: [[{ row: 0, kind: "contradiction", verdict: "" }, { row: 1, kind: "agreement" }]],
            },
        },
    };
    const a = { "O-1": { judges: [{ 0: { verdict: "matched", goldId: "g1", sufficiency: "sufficient" } }], consensus: null } };
    const b = { "O-1": { judges: [{ 0: { verdict: "matched", goldId: "g1", sufficiency: "insufficient" } }], consensus: null } };
    const engines = [engineFor("codex"), engineFor("antigravity")];
    const same = mergeAdjudications(template, [a, a], engines, { at: T0 });
    assert.equal(same.outputs["O-1"].judges[0][0].verdict, "matched");
    assert.equal(same.adjudicatorKind, "model");
    const split = mergeAdjudications(template, [a, b], engines, { at: T0 });
    assert.equal(split.outputs["O-1"].judges[0][0].verdict, "undetermined");
    assert.equal(split.outputs["O-1"].judges[0][1].kind, "agreement");
    assert.equal(split.disputes.length, 1);
});

test("judges that settle to the same outcome take judge 1's rows as consensus, repeat included", () => {
    const rows = [
        { row: 0, kind: "contradiction", verdict: "" },
        { row: 1, kind: "contradiction", verdict: "" },
        { row: 2, kind: "agreement" },
    ];
    const template = { outputs: { "O-1": { caseLabel: "사례 1", gold: {}, judges: [rows, rows] } } };
    const ruled = { 0: { verdict: "matched", goldId: "g1", sufficiency: "sufficient" }, 1: { verdict: "matched", goldId: "g1", sufficiency: "sufficient" } };
    // The two adjudicators chose different consensus rows (the live run's case: one dropped the repeat).
    const a = { "O-1": { judges: [ruled, ruled], consensus: [{ judge: 0, row: 0, kind: "contradiction", verdict: "matched", goldId: "g1", sufficiency: "sufficient" }] } };
    const b = { "O-1": { judges: [ruled, ruled], consensus: [] } };
    const merged = mergeAdjudications(template, [a, b], [engineFor("codex"), engineFor("antigravity")], { at: T0 });
    assert.deepEqual(merged.outputs["O-1"].consensus.map((item) => item.row), [0, 1]);
    assert.equal(merged.disputes.length, 0);
});

test("gold review binds freeze only when two vendors pass the exact gold", async () => {
    const bundle = loadFixture();
    const fake = fakeModels();
    const engines = [engineFor("codex", { call: { run: fake.run } }), engineFor("antigravity", { call: { run: fake.run } })];
    const review = await reviewGoldWithModels(bundle, engines, { at: T0 });
    assert.equal(freezeInputs(bundle, T0, { goldReview: review }).goldReviewStatus, "model_reviewed");
    assert.equal(freezeInputs(bundle, T0).goldReviewStatus, "candidate");

    const failing = structuredClone(review);
    failing.reviewers[1].pass = false;
    failing.reviewers[1].cases["qp-notice-1-ko"] = { ok: false, problems: [{ goldId: "qp-g-notice-1-ko-c1", issue: "span not in answer 2" }] };
    assert.throws(() => freezeInputs(bundle, T0, { goldReview: failing }), /antigravity 검토 불통과.*span not in answer 2/);

    const oneVendor = structuredClone(review);
    oneVendor.reviewers[1].vendor = "openai";
    assert.throws(() => freezeInputs(bundle, T0, { goldReview: oneVendor }), /서로 다른 회사 모델 둘/);

    const edited = structuredClone(bundle);
    edited.gold.cases["qp-notice-1-ko"].contradictions[0].rationale += " (edited)";
    assert.throws(() => freezeInputs(edited, T0, { goldReview: review }), /다른 사례·정답표/);

    const human = structuredClone(bundle);
    human.gold.review = { status: "human_reviewed", reviewedBy: "검토자", reviewedAt: T0 };
    const humanReview = { ...review, goldDigest: (await reviewGoldWithModels(human, engines, { at: T0 })).goldDigest };
    assert.equal(freezeInputs(human, T0, { goldReview: humanReview }).goldReviewStatus, "human_reviewed", "a model review never replaces a person's");
});

test("real outputs judged only by models are model_measured, never measured", async () => {
    await withOut(async (out) => {
        const fake = fakeModels();
        const { files } = await runModelJudges(PLAN, out, { run: fake.run, now: () => T0 });
        const bundle = loadFixture();
        for (const output of Object.values(bundle.outputs)) output.source = "real_capture";
        const freeze = JSON.parse(readFileSync(files.freeze, "utf8"));
        const records = [1, 2].map((slot) => JSON.parse(readFileSync(files.record(slot), "utf8")));
        const adjudication = JSON.parse(readFileSync(files.modelAdjudication, "utf8"));
        // Changing the source changes every output's binding; re-judge on the real bundle.
        const prepared = prepare(bundle, freeze);
        const engines = [engineFor("codex", { call: { run: fake.run } }), engineFor("antigravity", { call: { run: fake.run } })];
        const realRecords = [];
        for (const [index, engine] of engines.entries()) realRecords.push(await judgeWithModel(prepared, index + 1, engine, { at: T0 }));
        const template = adjudicationTemplate(bundle, freeze, realRecords);
        const realAdjudication = await adjudicateWithModels(template, realRecords, prepared.packets[0].markdown, engines, { at: T0 });
        const report = buildReport(bundle, freeze, { records: realRecords, adjudication: realAdjudication });
        assert.equal(report.products.Y.measurement.status, "model_measured");
        assert.match(renderReport(report), /모델 판정 측정 \(사람 판정 아님\)/);
        assert.ok(records.length === 2 && adjudication.adjudicatorKind === "model");
    });
});

test("codex and antigravity streams: the answer, or a refusal when a tool ran", () => {
    const codex = [
        { type: "thread.started", thread_id: "t" },
        { type: "item.completed", item: { id: "item_0", type: "error", message: "config warning" } },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_1", type: "reasoning", text: "…" } },
        { type: "item.completed", item: { id: "item_2", type: "agent_message", text: '{"ok":true}' } },
        { type: "turn.completed", usage: {} },
    ];
    assert.deepEqual(codexAnswer(codex.map((e) => JSON.stringify(e)).join("\n")), { text: '{"ok":true}' });
    const ran = [...codex.slice(0, 3), { type: "item.started", item: { id: "item_9", type: "command_execution", command: "cat key.json" } }, ...codex.slice(3)];
    assert.match(codexAnswer(ran.map((e) => JSON.stringify(e)).join("\n")).reason, /codex_tool_refused:command_execution/);
    assert.match(codexAnswer('{"type":"item.completed","item":{"type":"mcp_tool_call"}}').reason, /refused/);

    // Shape measured from agy 1.5.4 on the AMUX box, 2026-11-24.
    const agy = [
        { event: "init", conversation_id: "c", init: { model: "gemini-4-hydrogen-high", cwd: "/tmp/x", tools: ["read_file"] } },
        { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
        { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "OK" } },
        { event: "result", result: { status: "SUCCESS", response: "OK\n" } },
    ];
    assert.deepEqual(antigravityJudgeAnswer(agy.map((e) => JSON.stringify(e)).join("\n")), { text: "OK\n" });
    const tool = [...agy.slice(0, 2), { event: "step_update", step_update: { step_type: "tool", tool_name: "read_file" } }, ...agy.slice(2)];
    assert.equal(antigravityJudgeAnswer(tool.map((e) => JSON.stringify(e)).join("\n")).reason, "antigravity_tool_refused");
    assert.equal(antigravityJudgeAnswer(agy.slice(0, 3).map((e) => JSON.stringify(e)).join("\n")).reason, "antigravity_no_result");
});

test("over ssh the CLI runs quoted in a fresh remote folder, prompt on stdin", async () => {
    const seen = {};
    const spawnChild = (command, args) => {
        seen.command = command;
        seen.args = args;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = Object.assign(new EventEmitter(), {
            end: (text) => {
                seen.stdin = text;
                setImmediate(() => {
                    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "{}" } })}\n`));
                    child.emit("close", 0);
                });
            },
        });
        child.kill = () => {};
        return child;
    };
    const engine = engineFor("antigravity");
    const answer = await spawnEngine(engine, "judge this", { ssh: ["-T", "-i", "key", "tommy@host"], spawnChild });
    assert.deepEqual(answer, { text: "{}" });
    assert.equal(seen.command, "ssh");
    assert.deepEqual(seen.args.slice(0, 4), ["-T", "-i", "key", "tommy@host"]);
    const remote = seen.args[4];
    assert.match(remote, /^d=\$\(mktemp -d\) && cd "\$d"/);
    assert.match(remote, /AGY_CLI_DISABLE_AUTO_UPDATE='true'/);
    assert.match(remote, /'agy' '-p' '' /);
    assert.match(remote, /rm -rf "\$d"/);
    assert.ok(remote.includes(`'{"permissions":{"deny":["command(*)"`));
    assert.deepEqual(JSON.parse(seen.stdin), { event: "user", message: { content: "judge this" } });
});
