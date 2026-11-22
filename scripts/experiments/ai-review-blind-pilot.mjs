// Blind answer-comparison pilot CLI. Offline and local: reads and writes files
// only, calls no provider and sends nothing anywhere.
//
//   npm run experiment:ai-review-blind-pilot -- <command> [options]
//
//   freeze      --plan <plan.json> --out <dir>               pin cases + gold before importing outputs
//   prepare     --plan <plan.json> --out <dir>               judge packets, blank records, operator key
//   lock        --record <record.json> --judge "<name>"      a judge locks their own finished record
//   adjudicate  --plan <plan.json> --out <dir> --records a.json[,b.json]
//                                                            gold matching sheet (still no product key)
//   report      --plan <plan.json> --out <dir> [--records ...] [--adjudication <file>]
//   demo        [--out <dir>]                                whole flow on synthetic fixtures + mock judging
//
// Formats and the procedure: scripts/experiments/ai-review-blind-pilot/README.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    PilotInputError,
    adjudicationTemplate,
    buildReport,
    freezeInputs,
    lockRecord,
    prepare,
    renderReport,
} from "./ai-review-blind-pilot/core.mjs";
import { buildMockJudging } from "./ai-review-blind-pilot/mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PLAN = path.join(here, "ai-review-blind-pilot", "fixtures", "plan.json");
const FIXTURE_MOCK = path.join(here, "ai-review-blind-pilot", "fixtures", "mock-judging.json");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeText(file, `${JSON.stringify(value, null, 2)}\n`);
function writeText(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
}

/** Plan plus every file it names, paths resolved against the plan's folder. */
export function loadBundle(planFile) {
    const plan = readJson(planFile);
    const base = path.dirname(planFile);
    const outputs = {};
    for (const product of plan.products ?? []) {
        if (product.output) outputs[product.slot] = readJson(path.resolve(base, product.output));
    }
    return { plan, cases: readJson(path.resolve(base, plan.cases)), gold: readJson(path.resolve(base, plan.gold)), outputs };
}

const layout = (out) => ({
    freeze: path.join(out, "operator", "freeze.json"),
    key: path.join(out, "operator", "key.json"),
    adjudication: path.join(out, "operator", "adjudication-template.json"),
    packet: (slot) => path.join(out, `judge-${slot}`, "packet.md"),
    record: (slot) => path.join(out, `judge-${slot}`, "record.json"),
    reportMd: path.join(out, "report.md"),
    reportJson: path.join(out, "report.json"),
});

function writePrepared(prepared, files) {
    writeJson(files.key, prepared.key);
    for (const packet of prepared.packets) {
        writeText(files.packet(packet.judgeSlot), packet.markdown);
        writeJson(files.record(packet.judgeSlot), packet.record);
    }
}

function writeReport(report, files, format = "both") {
    if (format !== "json") writeText(files.reportMd, renderReport(report));
    if (format !== "md") writeJson(files.reportJson, report);
}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (!arg.startsWith("--")) throw new Error(`알 수 없는 인자: ${arg}`);
        const value = rest[index + 1] && !rest[index + 1].startsWith("--") ? rest[(index += 1)] : "true";
        options[arg.slice(2)] = value;
    }
    return { command, options };
}

const required = (options, name) => {
    if (!options[name] || options[name] === "true") throw new Error(`--${name}가 필요합니다`);
    return options[name];
};

export function runDemo(out, { now = "2026-11-22T00:00:00.000Z" } = {}) {
    const files = layout(out);
    const bundle = loadBundle(FIXTURE_PLAN);
    const freeze = freezeInputs(bundle, now);
    writeJson(files.freeze, freeze);
    const prepared = prepare(bundle, freeze);
    writePrepared(prepared, files);
    writeText(path.join(out, "report-before-judging.md"), renderReport(buildReport(bundle, freeze)));
    const { records, adjudication } = buildMockJudging(prepared, readJson(FIXTURE_MOCK));
    records.forEach((record) => writeJson(path.join(out, `judge-${record.judgeSlot}`, "record.mock-locked.json"), record));
    writeJson(path.join(out, "operator", "adjudication.mock-locked.json"), adjudication);
    const report = buildReport(bundle, freeze, { records, adjudication });
    writeReport(report, files);
    return { files, report };
}

function main(argv) {
    const { command, options } = parseArgs(argv);
    if (command === "demo") {
        const out = path.resolve(options.out && options.out !== "true" ? options.out : ".tmp/ai-review-blind-pilot/demo");
        const { files } = runDemo(out);
        console.log(`합성 시연 완료 (품질 미측정). 보고서: ${files.reportMd}`);
        return;
    }
    if (command === "lock") {
        const file = required(options, "record");
        const locked = lockRecord(readJson(file), { judge: required(options, "judge"), at: options.at ?? new Date().toISOString() });
        writeJson(file, locked);
        console.log(`기록을 잠갔습니다: ${file}`);
        return;
    }
    const planFile = path.resolve(required(options, "plan"));
    const files = layout(path.resolve(required(options, "out")));
    const bundle = loadBundle(planFile);
    if (command === "freeze") {
        writeJson(files.freeze, freezeInputs(bundle, options.at ?? new Date().toISOString()));
        console.log(`사례와 정답표를 고정했습니다: ${files.freeze}`);
        return;
    }
    const freeze = readJson(files.freeze);
    const records = (options.records && options.records !== "true" ? options.records.split(",") : []).map((file) => readJson(path.resolve(file)));
    if (command === "prepare") {
        const prepared = prepare(bundle, freeze);
        writePrepared(prepared, files);
        console.log(`판정자 묶음 ${prepared.packets.length}개와 운영자 키를 만들었습니다: ${path.dirname(files.key)}`);
        return;
    }
    if (command === "adjudicate") {
        writeJson(files.adjudication, adjudicationTemplate(bundle, freeze, records));
        console.log(`정답 대조지를 만들었습니다 (제품 키 없음): ${files.adjudication}`);
        return;
    }
    if (command === "report") {
        const adjudication = options.adjudication ? readJson(path.resolve(options.adjudication)) : null;
        writeReport(buildReport(bundle, freeze, { records, adjudication }), files, options.format ?? "both");
        console.log(`보고서: ${files.reportMd}`);
        return;
    }
    throw new Error(`알 수 없는 명령: ${command ?? "(없음)"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof PilotInputError ? error.message : `실패: ${error.message}`);
        process.exitCode = 1;
    }
}
