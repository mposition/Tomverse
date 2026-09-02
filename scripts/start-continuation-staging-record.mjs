#!/usr/bin/env node
/**
 * Opens a staging verification record for "continuing an imported
 * conversation", with everything an agent can settle already filled in.
 *
 * Checklist: docs/ops/external-conversation-continuation-staging-checklist.md
 * Record rules: the records README beside the file this writes.
 *
 * ## What this does and does not write
 *
 * It runs D-0 here and now and writes down what came back, it states the
 * fixtures' digests and their expected seed counts, and it leaves every row a
 * person has to observe empty. It never writes 판정 or 서명 — the records
 * README's rule 5 draws the line at observation versus judgement, and a script
 * that filled in "통과" would be making the one call the whole document exists
 * to record a human making.
 *
 * D-0 is executed rather than quoted. A line saying "an agent ran this
 * yesterday on another commit" is not evidence about this deployment, and the
 * whole point of D-0 is that §D must not run against a build whose role split
 * is not there.
 *
 * ## Why --deploy-sha is required and unverified
 *
 * This container has no production or Railway credentials, by policy, so it
 * cannot read what staging is running. The operator reads the SHA from the
 * Admin Console's **footer status bar** — `Version <first 12>`, beside "Job
 * health" and "API/DB", rendered from `RAILWAY_GIT_COMMIT_SHA` — and passes it
 * here. The script says plainly in the record that it took the value on trust
 * and whether the local tree matches it, rather than implying it checked.
 *
 * The one refusal worth naming is a Railway deployment id: it is a UUID, it
 * sits next to the commit in Railway's own UI, and it identifies a *deploy*
 * rather than the code that was deployed. Recording one would put a value in
 * the `deploySha` field that no `git` command can resolve, which is exactly
 * what the 40-character rule exists to prevent.
 *
 * Usage (this container or a clone; no credentials needed):
 *   npm run staging:continuation-record -- --deploy-sha <40 hex>
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECORDS = join(
    "docs",
    "ops",
    "external-conversation-continuation-staging-verification-records"
);
const TEMPLATE = join(RECORDS, "_record-template.md");
const FIXTURES = join(RECORDS, "fixtures");

const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? null : process.argv[index + 1] ?? null;
};

const fail = (message) => {
    console.error(`\n${message}\n`);
    process.exit(1);
};

const deploySha = (arg("deploy-sha") ?? "").trim().toLowerCase();

const WHERE_TO_LOOK =
    "Where to find it: Admin Console, the status bar along the BOTTOM of the page,\n" +
    '  "Version xxxxxxxxxxxx" beside "Job health" and "API/DB". That is the first 12\n' +
    "  characters of the deployed commit. Expand it locally with\n" +
    "    git rev-parse <those 12 characters>";

if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deploySha)) {
    // Named on purpose. Railway shows a deployment id right next to the commit,
    // and it is the likelier thing to copy: it is what the URL and the CLI talk
    // about. It identifies a deploy, not the code, so nothing in git can resolve
    // it and the record's `deploySha` would name something no reader could check
    // out.
    fail(
        `That looks like a Railway deployment id (a UUID), not a git commit.\n\n` +
            "A deployment id says which deploy ran; the record needs which *code* ran, so it\n" +
            "has to be a 40-character hex commit SHA.\n\n" +
            WHERE_TO_LOOK
    );
}

if (!/^[0-9a-f]{40}$/.test(deploySha)) {
    fail(
        "--deploy-sha must be the full 40-character commit the deployment is running.\n" +
            `Got ${deploySha.length} character(s).\n\n` +
            WHERE_TO_LOOK +
            "\n\nA short SHA in a record sends the next reader looking."
    );
}

/** Node's own runner, so a failure is a non-zero exit rather than a string. */
const runTest = (file, filter) => {
    const args = ["--import", "tsx", "--test"];
    if (filter) args.push(`--test-name-pattern=${filter}`);
    args.push(file);
    try {
        const out = execFileSync(process.execPath, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, out };
    } catch (error) {
        return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
};

const counts = (out) => {
    const pass = /^# pass (\d+)$/m.exec(out)?.[1] ?? "?";
    const failed = /^# fail (\d+)$/m.exec(out)?.[1] ?? "?";
    return { pass, failed };
};

console.log("Running D-0 (the prompt role boundary) ...");
const d0 = runTest(
    "tests/externalContinuationContracts.test.mjs",
    "never a system or developer message|reaches the provider as a message"
);
const d0Counts = counts(d0.out);

/*
  K-7, the half of it that runs anywhere.

  The checklist answers "one model's failure does not damage another's" with
  deterministic checks rather than paid turns, because staging offers no way to
  fail one provider and not the others, and buying failures to watch them is
  more expensive than what the item decides. The unit-level half runs here --
  no browser, no build, no credentials -- so the record carries a result rather
  than an instruction to go and get one.

  The browser-level half (tests/e2e/external-conversation-continuation.spec.ts,
  "one model failing leaves the other model's answer standing") needs a
  production build and a Chromium; it is run where one is available and its
  result is written into the row beside this one.
*/
console.log("Running K-7 (per-model failure isolation, unit level) ...");
const k7 = runTest(
    "tests/continuationModelPanels.test.mjs",
    "failure is reported on that panel|admitted once|never puts imported text"
);
const k7Counts = counts(k7.out);

console.log("Checking the fixtures against their answer key ...");
const fixtures = runTest("tests/continuationStagingFixtures.test.mjs");
const fixtureCounts = counts(fixtures.out);

if (!fixtures.ok) {
    fail(
        "The fixtures and manifest.json disagree, so the answer key cannot be trusted.\n" +
            "Regenerate with:  node --import tsx scripts/build-continuation-staging-fixtures.mjs\n\n" +
            fixtures.out.slice(-2000)
    );
}

const localSha = (() => {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        return null;
    }
})();
const localMatches = localSha === deploySha;

const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8")
);
const byName = Object.fromEntries(
    manifest.fixtures.map((row) => [row.file, row])
);
const fixtureRow = (file, description) => {
    const row = byName[file];
    const e = row.expected;
    return (
        `| \`fixtures/${file}\` | ${description} | ${row.bytes} B · \`sha256:${row.sha256_16}\` | ` +
        `${e.seedMessageCount}/${e.sourceMessageCount}턴, 잘림 ${e.truncatedCount}, 누락 ${e.omittedByBudgetCount} |`
    );
};

const today = new Date().toISOString().slice(0, 10);
const target = join(RECORDS, `${today}__${deploySha}.md`);
if (existsSync(target)) {
    fail(
        `${target} already exists. A record is one run; open the existing file rather than\n` +
            "overwriting what somebody already observed."
    );
}

let record = readFileSync(TEMPLATE, "utf8");

/*
  The revision, written once and read from one place.

  The template carried it twice -- in its front matter and again in the
  execution-environment table -- and only the front matter is what
  `check:staging-verification-records` compares against the checklist. So the
  table's copy drifted: it still said 2026-08-31b under a 2026-09-01a header,
  and a finished record would have named the wrong revision while the gate
  stayed green. The body now takes its value from the front matter it was
  opened with.
*/
const templateRevision =
    /^templateRevision:\s*(\S+)\s*$/m.exec(record)?.[1] ?? null;
if (!templateRevision) {
    fail("The template has no templateRevision in its front matter.");
}
record = record.replace(
    "| template revision | (기록을 열 때 front matter에서 채워집니다) |",
    `| template revision | ${templateRevision} |`
);

record = record.replace("environment:\n", "environment: staging\n");
record = record.replace("deploySha:\n", `deploySha: ${deploySha}\n`);

record = record.replace(
    "# 외부 대화 이어가기 staging 검증 실행 — <날짜> / <deploy SHA>",
    `# 외부 대화 이어가기 staging 검증 실행 — ${today} / ${deploySha.slice(0, 12)}

> **이 파일은 초안입니다.** 자동으로 채워진 것은 **D-0 실행 결과와 시료
> 정보**뿐입니다(기록 README 5번). 사람이 실행해야 알 수 있는 칸은 비어
> 있고, **판정과 서명은 비어 있습니다** — 그 둘은 사람만 씁니다.
>
> 실행자는 각 줄을 확인하고, 자기가 본 것을 관측 칸에 적은 뒤 commit 합니다.
> 확인하지 않은 줄을 그대로 두고 commit 하지 마십시오. 채워져 있다는 것이
> 확인됐다는 뜻이 되어 버립니다.
>
> **회차가 끝나기 전에는 commit 하지 마십시오.** front matter의 \`executor\`와
> \`result\`가 비어 있는 동안 \`npm run check:staging-verification-records\`가
> 실패합니다 — 의도된 것입니다. 빈 기록이 저장소에 있으면 끝난 회차처럼
> 읽힙니다.
>
> \`--deploy-sha\`는 실행자가 준 값을 **그대로 믿고** 적었습니다. 이 컨테이너에는
> production·Railway 자격증명이 없어 배포본을 읽을 수 없습니다. Admin Console
> **화면 아래쪽 상태 표시줄**의 \`Version\` 12자리와 위 SHA의 앞 12자리가 같은지
> 확인하십시오 — 헤더가 아니라 footer이고, \`Job health\`·\`API/DB\`와 같은
> 줄입니다.`
);

record = record.replace(
    "| 배포 SHA (전체 40자리) | |",
    `| 배포 SHA (전체 40자리) | \`${deploySha}\` (실행자 신고, 스크립트가 검증하지 않음) |`
);
record = record.replace(
    "| 시작 (UTC) | |",
    `| 시작 (UTC) | ${new Date().toISOString()} (기록 생성 시각) |`
);

record = record.replace(
    `| 시료 | 무엇을 담았는가 | 준비됨 |
|---|---|---|
| 평범한 import 대화 (user/assistant 10턴 이상) | | |
| prompt-injection 문자열과 fence marker를 담은 대화 | | |
| 잘린 메시지를 포함한 대화 | | |`,
    `시료는 에이전트가 만들었습니다(기록 README 8번). 정답지는
\`fixtures/manifest.json\`이고, 이 실행에서 \`tests/continuationStagingFixtures.test.mjs\`
${fixtureCounts.pass} pass / ${fixtureCounts.failed} fail 로 파일·정답지·실제 adapter가 서로 맞는 것을 확인했습니다.

| 시료 | 무엇을 담았는가 | 크기·digest | seed 예상 |
|---|---|---|---|
${fixtureRow("plain-conversation.json", "평범한 대화. 주입 문자열 없음 — §A·§B·§C·§E·§H·§I·§J가 이것으로 됩니다")}
${fixtureRow("injection-conversation.json", "주입 3종(override·위조 fence·사칭)이 **전부 외부 assistant 발언 안**에 — §D 전용")}
${fixtureRow("truncation-conversation.json", "4,000자 상한을 넘는 답변 3개 — §F-3 잘림 고지")}

| 시료 업로드 확인 | 관측 | 판정 |
|---|---|---|
| 세 파일이 import 되고 대화 3건이 생겼는가 | | |
| 각 대화의 메시지 수가 위 표의 분모와 같은가 | | |`
);

record = record.replace(
    "| K-7 실패 격리 결정적 검사 통과 여부 (유료 turn 없음) | | |",
    `| K-7 실패 격리 결정적 검사 (유료 turn 없음) | **이 기록을 만들며 실행:** \`tests/continuationModelPanels.test.mjs\` 의 격리·admission·본문 세 건 — ${k7Counts.pass} pass / ${k7Counts.failed} fail → **${k7.ok ? "통과" : "실패"}**. 로컬 트리 \`${localSha ?? "unknown"}\`. 브라우저 쪽 절반(\`tests/e2e/external-conversation-continuation.spec.ts\` "one model failing leaves the other model's answer standing")은 build와 Chromium이 있는 곳에서 실행하고 그 결과를 여기에 덧붙입니다. | |`
);

record = record.replace(
    "| D-0 role 경계 테스트 통과 | | |",
    `| D-0 role 경계 테스트 통과 | **이 기록을 만들며 실행:** \`tests/externalContinuationContracts.test.mjs\` 의 role-boundary 두 건 — ${d0Counts.pass} pass / ${d0Counts.failed} fail → **${d0.ok ? "통과" : "실패"}**. 로컬 트리 \`${localSha ?? "unknown"}\`, 신고된 배포 SHA와 ${localMatches ? "**일치**" : "**불일치 — 아래 주의**"}. | |`
);

if (!localMatches) {
    record = record.replace(
        "## §D prompt boundary (차단)",
        `## §D prompt boundary (차단)

> **주의.** D-0은 이 clone의 트리(\`${localSha ?? "unknown"}\`)에서 실행됐고, 그것은
> 신고된 배포 SHA(\`${deploySha}\`)와 다릅니다. 두 트리에서 \`lib/externalContinuationSeedPrompt.ts\`·
> \`lib/chatTurnSystemBlocks.ts\`·\`app/api/chat/route.ts\`가 같은지 확인하기 전에는
> **§D를 실행하지 마십시오** — 확인 방법:
> \`git diff ${deploySha} ${localSha ?? "HEAD"} -- lib/externalContinuationSeedPrompt.ts lib/chatTurnSystemBlocks.ts app/api/chat/route.ts\`
> 출력이 비어 있으면 이 D-0은 배포본에 대해서도 유효합니다.`
    );
}

writeFileSync(target, record, "utf8");

console.log(`\nD-0: ${d0.ok ? "PASS" : "FAIL"} (${d0Counts.pass} pass / ${d0Counts.failed} fail)`);
console.log(`K-7 (unit): ${k7.ok ? "PASS" : "FAIL"} (${k7Counts.pass} pass / ${k7Counts.failed} fail)`);
console.log(
    `fixtures: ${fixtureCounts.pass} pass / ${fixtureCounts.failed} fail`
);
console.log(`local tree ${localMatches ? "matches" : "DOES NOT match"} the reported deploy SHA`);
console.log(`\nrecord opened: ${target}`);
console.log(
    "Do NOT commit it until the run is finished: `executor` and `result` are empty,\n" +
        "so check:staging-verification-records will fail by design while it is a blank page."
);
if (!d0.ok) {
    console.log(
        "\nD-0 failed, so §D must not be run on this deployment (checklist §D 선행 조건)."
    );
}
