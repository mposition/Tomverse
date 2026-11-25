// Model stand-ins for the pilot's three person steps: gold review, judging and
// adjudication. Owner direction 2026-11-24: the outputs and gold were written
// by Claude, so the judges are two other vendors' CLI models, Codex (OpenAI)
// and Antigravity (Google Gemini), each run on its own subscription login.
//
// What keeps this honest:
// - A judge sees exactly the blinded packet. The prompt is checked against the
//   same forbidden terms as the packet before any call, and runs in an empty
//   folder with every tool denied; a run that used a tool is refused.
// - Everything written says it is a model: records carry judge.kind "model",
//   the adjudication adjudicatorKind "model", and the gold review its own file
//   that freeze binds. Nothing becomes human_reviewed or a person's name.
// - Two models must agree. A gold review passes only when both pass it; an
//   adjudication verdict stands only when both adjudicators give the same one,
//   and every disagreement is left undetermined and listed for a person.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { antigravityStdin, antigravityUnknownKindActs } from "../../../tools/review-orchestrator/lib/antigravity.mjs";
import { PilotInputError, SCHEMA, SCORED_KINDS, VERDICTS, appearsIn, digestOf, lockRecord, recordProblems } from "./core.mjs";

const DENY_ALL = JSON.stringify({ permissions: { deny: ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"] } });
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export const ENGINES = Object.freeze({
    codex: {
        id: "codex",
        vendor: "openai",
        label: "Codex",
        model: null,
        command: "codex",
        args: (engine, cwd) => ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", ...(engine.model ? ["-m", engine.model] : []), "-C", cwd, "-"],
        stdin: (prompt) => prompt,
        answer: (stdout) => codexAnswer(stdout),
        env: {},
    },
    antigravity: {
        id: "antigravity",
        vendor: "google",
        label: "Antigravity",
        model: "gemini-4-hydrogen-high",
        command: "agy",
        args: (engine) => ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json", "--model", engine.model, "--disable-slash-commands", "--settings", DENY_ALL],
        stdin: antigravityStdin,
        answer: (stdout) => antigravityJudgeAnswer(stdout),
        env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    },
});

/** An engine with its model override and its call options ({ssh} or a test's {run}). */
export function engineFor(id, { model, call = {} } = {}) {
    const engine = ENGINES[id];
    if (!engine) throw new PilotInputError([`알 수 없는 판정 엔진: ${id} (codex | antigravity)`]);
    return { ...engine, model: model ?? engine.model, call };
}

export const judgeIdentity = (engine) => ({
    name: `${engine.label} 모델 판정자 (사람 아님)`,
    kind: "model",
    engine: engine.id,
    vendor: engine.vendor,
    model: engine.model ?? "default",
});

// ---------------------------------------------------------------------------
// Answers from the two CLIs' event streams
// ---------------------------------------------------------------------------

/** Codex `exec --json`: the last agent message, refused if any tool ran. */
export function codexAnswer(stdout) {
    let text = null;
    for (const line of String(stdout ?? "").split("\n")) {
        if (line.trim() === "") continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return { reason: "codex_stream_invalid" };
        }
        if (event.type === "turn.failed" || event.type === "error") return { reason: "codex_turn_failed" };
        if (event.type !== "item.completed" && event.type !== "item.started" && event.type !== "item.updated") continue;
        const type = event.item?.type;
        // Config warnings arrive as error items; anything that acts is refused.
        if (!["agent_message", "reasoning", "error"].includes(type)) return { reason: `codex_tool_refused:${type}` };
        if (event.type === "item.completed" && type === "agent_message") text = event.item.text;
    }
    return typeof text === "string" && text.trim() ? { text } : { reason: "codex_no_answer" };
}

/** agy stream-json: the final result, refused if any step names a tool. */
export function antigravityJudgeAnswer(stdout) {
    let result = null;
    for (const line of String(stdout ?? "").split("\n")) {
        if (line.trim() === "") continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return { reason: "antigravity_stream_invalid" };
        }
        if (event?.event === "result") result = event.result;
        if (event?.event === "init" || event?.event === "result") continue;
        if (event?.event !== "step_update") {
            if (antigravityUnknownKindActs(event?.event, event)) return { reason: "antigravity_event_unexpected" };
            continue;
        }
        const step = event.step_update ?? {};
        if (Object.hasOwn(step, "tool_name") || Object.hasOwn(step, "tool_info") || Object.hasOwn(step, "subagent_info")) return { reason: "antigravity_tool_refused" };
        if (!["user_input", "agent_response", "checkpoint"].includes(step.step_type) && antigravityUnknownKindActs(step.step_type, step)) {
            return { reason: "antigravity_step_unexpected" };
        }
    }
    if (result?.status !== "SUCCESS" || typeof result.response !== "string" || !result.response.trim()) return { reason: "antigravity_no_result" };
    return { text: result.response };
}

// ---------------------------------------------------------------------------
// Running a CLI (locally, or on another host through ssh)
// ---------------------------------------------------------------------------

const posixQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const winQuote = (value) => (/[\s"&|<>^]/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value);

/**
 * One model call. `ssh` is the ssh argument list for a host whose login holds
 * the CLI (Antigravity is signed in on the AMUX box); the command then runs in
 * a fresh temp folder there that is removed afterwards.
 */
export function spawnEngine(engine, prompt, { ssh = null, timeoutMs = DEFAULT_TIMEOUT_MS, spawnChild = spawn } = {}) {
    return new Promise((resolve) => {
        let local = null;
        let command;
        let args;
        let options;
        if (ssh) {
            const env = Object.entries(engine.env).map(([key, value]) => `${key}=${posixQuote(value)}`).join(" ");
            const run = [engine.command, ...engine.args(engine, ".")].map(posixQuote).join(" ");
            const remote = `d=$(mktemp -d) && cd "$d" && export PATH="$HOME/.local/bin:$PATH"${env ? ` ${env}` : ""} && ${run}; rc=$?; cd /; rm -rf "$d"; exit $rc`;
            command = "ssh";
            args = [...ssh, remote];
            options = { stdio: ["pipe", "pipe", "pipe"] };
        } else {
            local = mkdtempSync(path.join(os.tmpdir(), "ai-review-judge-"));
            const windows = process.platform === "win32";
            command = engine.command;
            args = engine.args(engine, local);
            if (windows) args = args.map(winQuote);
            options = { cwd: local, shell: windows, env: { ...process.env, ...engine.env }, stdio: ["pipe", "pipe", "pipe"] };
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        let child;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (local) rmSync(local, { recursive: true, force: true });
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { child?.kill(); } catch { /* gone */ }
            finish({ reason: `${engine.id}_timeout` });
        }, timeoutMs);
        try {
            child = spawnChild(command, args, options);
        } catch (error) {
            return finish({ reason: `${engine.id}_spawn_failed: ${error.message}` });
        }
        child.on("error", (error) => finish({ reason: `${engine.id}_spawn_failed: ${error.message}` }));
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("close", (code) => {
            const answer = engine.answer(stdout);
            if (answer.text !== undefined) return finish(answer);
            finish({ reason: `${answer.reason}${code ? ` (exit ${code})` : ""}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}` });
        });
        child.stdin.on("error", () => { /* closed early; close reports it */ });
        child.stdin.end(engine.stdin(prompt));
    });
}

/** The first JSON object in a model's answer (fences and prose around it allowed). */
export function extractJson(text) {
    const body = String(text ?? "").replace(/```(?:json)?/g, "");
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return { problems: ["JSON 객체가 없습니다"] };
    try {
        return { value: JSON.parse(body.slice(start, end + 1)) };
    } catch (error) {
        return { problems: [`JSON을 읽을 수 없습니다: ${error.message}`] };
    }
}

/**
 * Ask, parse, check; on a malformed answer ask once more with the problems.
 * A refused run (a tool was used, a timeout) is not asked again: that is a
 * failure of the call, not of the format.
 */
async function askJson(engine, prompt, check, options = {}) {
    // engine.call carries that engine's own host (ssh) or a test's fake call.
    const { run = spawnEngine, ...callOptions } = { ...options, ...(engine.call ?? {}) };
    let current = prompt;
    let problems = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const answer = await run(engine, current, callOptions);
        if (answer.text === undefined) throw new PilotInputError([`${engine.label} 호출 실패: ${answer.reason}`]);
        const parsed = extractJson(answer.text);
        problems = parsed.problems ?? check(parsed.value).problems;
        if (problems.length === 0) return check(parsed.value).value;
        current = `${prompt}\n\n## Your previous answer was rejected\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\nPrevious answer:\n\n${answer.text}\n\nReturn the corrected JSON object only.`;
    }
    throw new PilotInputError([`${engine.label}의 답을 두 번 모두 받아들일 수 없습니다`, ...problems]);
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

const JUDGE_TASK = `You are a blind judge in a small evaluation of an "answer comparison" reviewer.
The packet below holds, for each case, a document, a question, two fixed answers and one or
more anonymous reviewer outputs. Judge only what each output says. Do not guess which product
or model wrote it. Do not use tools or read files; everything you need is in this message.

Follow the packet's "판정 방법" section exactly. For every output, write at least one row per
segment (F1, F2, ...), splitting a segment that makes two independent claims. A finding in raw
text that has no segment uses segment "RAW" with the sentence copied verbatim into "excerpt".

Row fields:
- segment: the segment id, or "RAW"
- excerpt: null, or for RAW the verbatim sentence
- kind: contradiction | missing | document_error | agreement | difference | not_a_finding | other
- targets: the original answer numbers the row is about, e.g. ["1","2"] (not the output's A/B labels)
- statement: one sentence: the claim the output makes (subject, condition, period, values)
- support: only for a segment that has quotes and kind contradiction: supports | does_not_support | undeterminable; otherwise null
- note: ""

Return one JSON object and nothing else:
{"outputs":[{"outputId":"O-...","rows":[{...}]}]}
Include every output listed under "Outputs to judge".`;

export function judgePrompt(packet) {
    const outputs = packet.record.outputs.map((output) => ({ outputId: output.outputId, segments: output.segments }));
    return `${JUDGE_TASK}\n\n## Outputs to judge\n\n${JSON.stringify(outputs, null, 2)}\n\n## Packet\n\n${packet.markdown}`;
}

/** The judge's answer written into the blank record, or what is wrong with it. */
export function fillRecord(blank, answer, judge) {
    const problems = [];
    const byId = new Map((Array.isArray(answer?.outputs) ? answer.outputs : []).map((output) => [output?.outputId, output]));
    const record = structuredClone(blank);
    record.judge = { ...judge };
    for (const output of record.outputs) {
        const judged = byId.get(output.outputId);
        if (!judged || !Array.isArray(judged.rows)) {
            problems.push(`출력 ${output.outputId}의 rows가 없습니다`);
            continue;
        }
        output.rows = judged.rows.map((row) => ({
            segment: row?.segment,
            excerpt: row?.excerpt ?? null,
            kind: row?.kind,
            targets: Array.isArray(row?.targets) ? row.targets.map(String) : row?.targets,
            statement: row?.statement ?? "",
            support: row?.support ?? null,
            note: typeof row?.note === "string" ? row.note : "",
        }));
        output.reviewed = true;
    }
    problems.push(...recordProblems(record));
    return { problems, value: record };
}

/** Product identity only (names, aliases, model ids, output file names). */
export function productTerms(bundle) {
    const terms = new Set(bundle.plan.forbiddenTerms ?? []);
    for (const product of bundle.plan.products ?? []) if (product.output) terms.add(path.basename(product.output));
    for (const output of Object.values(bundle.outputs ?? {})) {
        for (const term of [output?.productName, ...(output?.aliases ?? []), ...(output?.modelIds ?? [])]) if (typeof term === "string" && term.trim()) terms.add(term);
    }
    return [...terms];
}

function assertBlind(prompt, terms) {
    const leaks = terms.filter((term) => appearsIn(term, prompt));
    if (leaks.length) throw new PilotInputError([`모델 판정 입력에 식별 정보가 ${leaks.length}개 남아 있어 호출하지 않았습니다`]);
}

export async function judgeWithModel(prepared, judgeSlot, engine, { at, ...options } = {}) {
    const packet = prepared.packets.find((candidate) => candidate.judgeSlot === judgeSlot);
    if (!packet) throw new PilotInputError([`판정자 슬롯 ${judgeSlot}의 묶음이 없습니다`]);
    const prompt = judgePrompt(packet);
    assertBlind(prompt, prepared.terms);
    const judge = judgeIdentity(engine);
    const record = await askJson(engine, prompt, (answer) => fillRecord(packet.record, answer, judge), options);
    return lockRecord(record, { judge: judge.name, at: at ?? new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Adjudication: both models rule independently, only agreement stands
// ---------------------------------------------------------------------------

const ADJUDICATE_TASK = `You adjudicate locked judge records against a gold list, in a small evaluation of an
"answer comparison" reviewer. You do not know, and must not guess, which product wrote any
output. Do not use tools or read files.

For each output and each judge row whose kind is contradiction, missing or document_error, give:
- verdict: matched (the row states a gold item of the same kind) | false_finding (wrong, or not
  in the gold where the gold is complete) | gold_gap (a correct finding the gold lacks) |
  undetermined (you cannot rule)
- goldId: the matched gold item's goldId, else null
- sufficiency: "insufficient" when a matched row names the subject but not the condition or
  period that makes it a contradiction; otherwise "sufficient"
A contradiction is two claims that cannot both be true for the same subject, condition and
period. Two answers that share the same wrong value contradict each other zero times.

When an output has two judges, also give "consensus": the scored rows that stand as the agreed
findings, each {"judge":0|1,"row":<row index>,"verdict":...,"goldId":...,"sufficiency":...}.
When the same finding was recorded by both judges, name it once (one judge's row). When the
output itself repeats a finding in two segments, keep both rows: the repeat is scored as a
duplicate. If no scored row stands, give [].

Return one JSON object and nothing else:
{"outputs":{"<outputId>":{"judges":[[{"row":0,"verdict":"...","goldId":null,"sufficiency":"sufficient"}], ...],"consensus":[...]}}}
List every scored row of every output in the sheet; leave out rows of other kinds.`;

export function adjudicationPrompt(template, records, packetMarkdown) {
    const sheet = Object.entries(template.outputs).map(([outputId, output]) => ({
        outputId,
        caseLabel: output.caseLabel,
        gold: output.gold,
        judges: records.map((record) => (record.outputs.find((item) => item.outputId === outputId)?.rows ?? []).map((row, index) => ({ row: index, ...row }))),
    }));
    return `${ADJUDICATE_TASK}\n\n## Sheet\n\n${JSON.stringify(sheet, null, 2)}\n\n## The packet the judges read\n\n${packetMarkdown}`;
}

const scoredRows = (rows) => rows.map((row, index) => ({ ...row, index })).filter((row) => SCORED_KINDS.includes(row.kind));

export function checkAdjudicationAnswer(template, answer) {
    const problems = [];
    const value = {};
    const goldIdsOf = (gold) => new Set([...gold.contradictions, ...gold.missing, ...gold.jointDocumentErrors].map((item) => item.goldId));
    const ruling = (item, where, gold) => {
        if (!VERDICTS.includes(item?.verdict)) problems.push(`${where}: verdict는 ${VERDICTS.join("|")}입니다`);
        if (item?.verdict === "matched" && !goldIdsOf(gold).has(item.goldId)) problems.push(`${where}: matched의 goldId가 이 사례 정답에 없습니다`);
        const sufficiency = item?.sufficiency === "insufficient" && item?.verdict === "matched" ? "insufficient" : "sufficient";
        return { verdict: item?.verdict, goldId: item?.verdict === "matched" ? item.goldId : null, sufficiency };
    };
    for (const [outputId, sheet] of Object.entries(template.outputs)) {
        const given = answer?.outputs?.[outputId];
        if (!given) {
            problems.push(`출력 ${outputId}가 없습니다`);
            continue;
        }
        const judges = sheet.judges.map((rows, judge) => {
            const byRow = new Map((given.judges?.[judge] ?? []).map((item) => [item?.row, item]));
            return Object.fromEntries(scoredRows(rows).map((row) => [row.index, ruling(byRow.get(row.index), `출력 ${outputId} 판정자 ${judge} 행 ${row.index}`, sheet.gold)]));
        });
        let consensus = null;
        if (sheet.judges.length > 1) {
            if (!Array.isArray(given.consensus)) problems.push(`출력 ${outputId}: consensus 배열이 없습니다`);
            else {
                consensus = given.consensus.map((item, index) => {
                    const row = sheet.judges[item?.judge]?.[item?.row];
                    if (!row || !SCORED_KINDS.includes(row.kind)) problems.push(`출력 ${outputId} consensus[${index}]: 채점 대상 행이 아닙니다`);
                    return { judge: item?.judge, row: item?.row, kind: row?.kind, ...ruling(item, `출력 ${outputId} consensus[${index}]`, sheet.gold) };
                });
            }
        }
        value[outputId] = { judges, consensus };
    }
    return { problems, value };
}

const rulingKey = (item) => `${item.verdict}|${item.goldId ?? ""}|${item.sufficiency}`;
const consensusKey = (items) => items.map((item) => `${item.kind}|${rulingKey(item)}`).sort().join(";");

/** Two adjudicators' rulings into one sheet; a disagreement stays undetermined. */
export function mergeAdjudications(template, rulings, adjudicators, { at }) {
    const disputes = [];
    const outputs = {};
    for (const [outputId, sheet] of Object.entries(template.outputs)) {
        const judges = sheet.judges.map((rows, judge) =>
            rows.map((row, index) => {
                if (!SCORED_KINDS.includes(row.kind)) return row;
                const given = rulings.map((ruling) => ruling[outputId].judges[judge][index]);
                if (new Set(given.map(rulingKey)).size === 1) return { ...row, ...given[0] };
                disputes.push({ outputId, caseLabel: sheet.caseLabel, judge, row: index, rulings: given });
                return { ...row, verdict: "undetermined", goldId: null, sufficiency: "sufficient" };
            })
        );
        const entry = { caseLabel: sheet.caseLabel, gold: sheet.gold, judges };
        if (sheet.judges.length > 1) {
            const given = rulings.map((ruling) => ruling[outputId].consensus);
            const settled = judges.map((rows) => scoredRows(rows));
            const sameOutcome = new Set(settled.map((rows) => consensusKey(rows))).size === 1;
            if (sameOutcome && settled[0].every((row) => row.verdict !== "undetermined")) {
                // Both judges' rows settled to the same outcome: judge 1's rows are the
                // consensus as they stand, with nothing left for a model to choose.
                entry.consensus = settled[0].map((row) => ({ judge: 0, row: row.index, verdict: row.verdict, goldId: row.goldId, sufficiency: row.sufficiency }));
            } else if (new Set(given.map(consensusKey)).size === 1) entry.consensus = given[0].map((item) => ({ judge: item.judge, row: item.row, verdict: item.verdict, goldId: item.goldId, sufficiency: item.sufficiency }));
            else {
                entry.consensus = null;
                entry.disputed = true;
                disputes.push({ outputId, caseLabel: sheet.caseLabel, consensus: given });
            }
        }
        outputs[outputId] = entry;
    }
    return {
        ...template,
        adjudicatedBy: `모델 대조자 ${adjudicators.map((engine) => engine.label).join(" + ")} (사람 아님)`,
        adjudicatedAt: at,
        adjudicatorKind: "model",
        adjudicators: adjudicators.map(judgeIdentity),
        status: "locked",
        disputes,
        outputs,
    };
}

export async function adjudicateWithModels(template, records, packetMarkdown, engines, { at, terms = [], ...options } = {}) {
    const prompt = adjudicationPrompt(template, records, packetMarkdown);
    // The gold ids are the point of this step; only product identity must stay out.
    assertBlind(prompt, terms);
    const rulings = [];
    for (const engine of engines) rulings.push(await askJson(engine, prompt, (answer) => checkAdjudicationAnswer(template, answer), options));
    return mergeAdjudications(template, rulings, engines, { at: at ?? new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Gold review (before freeze; no outputs exist yet)
// ---------------------------------------------------------------------------

const GOLD_TASK = `You review a candidate gold list for a small evaluation of an "answer comparison" reviewer,
before any reviewer output exists. Do not use tools or read files.

For every case check every gold item against the case's document, question and two answers:
- each answerSpans quote appears verbatim in the named answer, and the values, subject,
  condition and period are stated correctly;
- each contradiction really is two claims that cannot both be true for the same subject,
  condition and period (a difference under different conditions is not one; two answers that
  share a wrong value are a joint document error, not a contradiction);
- each missing item is something the question requires and that answer really omits;
- each joint document error matches the document value and both answers;
- "completeness" true means no further item of that kind exists in the case;
- counterpartGoldId pairs the same finding in the other language.

Return one JSON object and nothing else:
{"cases":{"<caseId>":{"ok":true|false,"problems":[{"goldId":"... or null","issue":"one sentence"}]}}}
List every case. ok is true only when problems is empty.`;

export function goldReviewPrompt(bundle) {
    return `${GOLD_TASK}\n\n## Cases\n\n${JSON.stringify(bundle.cases, null, 2)}\n\n## Candidate gold\n\n${JSON.stringify(bundle.gold, null, 2)}`;
}

export function checkGoldAnswer(bundle, answer) {
    const problems = [];
    const value = {};
    for (const { caseId } of bundle.cases.cases) {
        const given = answer?.cases?.[caseId];
        if (!given || typeof given.ok !== "boolean" || !Array.isArray(given.problems)) {
            problems.push(`사례 ${caseId}의 ok·problems가 없습니다`);
            continue;
        }
        const found = given.problems.map((item) => ({ goldId: item?.goldId ?? null, issue: String(item?.issue ?? "") }));
        value[caseId] = { ok: given.ok && found.length === 0, problems: found };
    }
    return { problems, value };
}

export async function reviewGoldWithModels(bundle, engines, { at, ...options } = {}) {
    const prompt = goldReviewPrompt(bundle);
    const reviewers = [];
    for (const engine of engines) {
        const cases = await askJson(engine, prompt, (answer) => checkGoldAnswer(bundle, answer), options);
        reviewers.push({ ...judgeIdentity(engine), pass: Object.values(cases).every((item) => item.ok), cases });
    }
    return {
        schema: SCHEMA.goldReview,
        casesDigest: digestOf(bundle.cases),
        goldDigest: digestOf(bundle.gold),
        reviewedAt: at ?? new Date().toISOString(),
        reviewers,
    };
}
