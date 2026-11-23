import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../tools/memory-quality/cli.ts";

// followup-answers is exercised only behind a fake fetch and a synthetic key.
const KEY = "sk-synthetic-followup-answers-key";

const responseBody = (body, text) => ({
    id: "resp_test", object: "response", created_at: 1_700_000_000, model: body.model, status: "completed",
    incomplete_details: null,
    output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 10 } },
});

test("followup-answers answers each distinct message once, stops on a failure and resumes the rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "followup-answers-"));
    try {
        const evalOut = join(directory, "eval");
        await main(["followup-eval", "--out", evalOut]);
        const requestsPath = join(evalOut, "answer-requests.json");
        const requests = JSON.parse(await readFile(requestsPath, "utf8"));
        const distinct = new Set(requests.requests.map(row => row.messagesDigest)).size;
        assert.ok(distinct >= 3 && distinct <= requests.requests.length);

        const bodies = [];
        let failAt = 3;
        const fetchImpl = async (url, init) => {
            const body = JSON.parse(init.body);
            bodies.push({ url: String(url), body, authorization: new Headers(init.headers).get("authorization") });
            if (bodies.length === failAt) return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
            return new Response(JSON.stringify(responseBody(body, `answer ${bodies.length}`)), { headers: { "content-type": "application/json" } });
        };
        const env = { OPENAI_API_KEY: KEY };
        const base = ["followup-answers", "--requests", requestsPath];
        const collect = (save, extra = [], context = { env, fetchImpl }) => main([...base, "--live", "--max-calls", String(distinct),
            "--max-usd", "1", "--save-answers", save, ...extra], context);

        // Refused before any request.
        await assert.rejects(main([...base, "--max-calls", "5", "--max-usd", "1", "--save-answers", join(directory, "x.json")], { env, fetchImpl }),
            { code: "live_required" });
        await assert.rejects(main([...base, "--live", "--max-calls", "5", "--save-answers", join(directory, "x.json")], { env, fetchImpl }),
            { code: "max_usd_required" });
        await assert.rejects(main([...base, "--live", "--max-calls", String(distinct - 1), "--max-usd", "1",
            "--save-answers", join(directory, "x.json")], { env, fetchImpl }), { code: "max_calls_below_planned" });
        await assert.rejects(main([...base, "--live", "--max-calls", String(distinct), "--max-usd", "0.000001",
            "--save-answers", join(directory, "x.json")], { env, fetchImpl }), { code: "max_usd_below_planned" });
        await assert.rejects(collect(join(directory, "x.json"), [], { env: {}, fetchImpl }), { code: "live_env_missing" });
        const tampered = join(directory, "tampered.json");
        const changed = structuredClone(requests);
        changed.requests[0].messages.at(-1).content += " (edited)";
        await writeFile(tampered, JSON.stringify(changed));
        await assert.rejects(main(["followup-answers", "--requests", tampered, "--live", "--max-calls", String(distinct),
            "--max-usd", "1", "--save-answers", join(directory, "x.json")], { env, fetchImpl }), { code: "answer_requests_digest_mismatch" });
        assert.equal(bodies.length, 0);

        const partial = join(directory, "partial.json");
        const stopped = await collect(partial);
        assert.equal(stopped.stopReason, "live_call_failed");
        assert.equal(stopped.failure, "rate_limited");
        assert.equal(stopped.paidCalls, 3);
        assert.equal(bodies.length, 3);
        const first = bodies[0];
        assert.equal(first.url, "https://api.openai.com/v1/responses");
        assert.equal(first.authorization, `Bearer ${KEY}`);
        assert.equal(first.body.model, "gpt-6-luna");
        assert.equal(first.body.reasoning?.effort, "medium");
        assert.equal(first.body.max_output_tokens, 4096);
        const saved = JSON.parse(await readFile(partial, "utf8"));
        assert.equal(saved.generator.kind, "mock");
        assert.equal(saved.generator.settings.complete, false);
        assert.equal(saved.generator.settings.unknownCostCalls, 1);
        assert.equal(new Set(saved.answers.map(row => row.messagesDigest)).size, 2);
        assert.ok(!JSON.stringify(saved).includes(KEY) && !JSON.stringify(stopped).includes(KEY));
        await assert.rejects(collect(partial), { code: "save_answers_exists" });

        failAt = 0;
        const complete = join(directory, "answers.json");
        const resumed = await collect(complete, ["--resume-answers", partial]);
        assert.equal(resumed.stopReason, undefined);
        assert.equal(resumed.paidCalls, distinct - 2);
        assert.equal(bodies.length, 3 + distinct - 2);
        const answers = JSON.parse(await readFile(complete, "utf8"));
        assert.equal(answers.generator.settings.complete, true);
        assert.equal(answers.answers.length, requests.requests.length);
        for (const row of saved.answers) {
            assert.equal(answers.answers.find(entry => entry.caseId === row.caseId && entry.condition === row.condition).text, row.text);
        }

        // followup-eval accepts the file as the same request contract; a fake fetch never counts as a measurement.
        await main(["followup-eval", "--out", join(directory, "eval-2"), "--answers", complete]);
        const report = JSON.parse(await readFile(join(directory, "eval-2", "report.json"), "utf8"));
        assert.equal(report.answers.answerQuality.status, "not_run");
        assert.equal(report.answers.answerQuality.reason, "answer_source_mock");
        assert.equal(report.answers.answerQuality.plumbingAnswers, requests.requests.length);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
