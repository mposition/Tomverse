// Real-model verification of the built CLI against a real Tomverse endpoint.
// PAID: every model step is a charged API request. Run it only with an approved
// budget, on a key that has a credit cap (it refuses a key without one).
//
//   TOMVERSE_API_KEY=<capped key> node apps/tomverse-cli/scripts/real-model-check.mjs \
//       --endpoint https://<host>/api/v1 --model <id> [--max-requests 12]
//
// It works only in synthetic repositories it creates in a temp folder. Every
// patch and command the model proposes is shown at the terminal and needs the
// person running it to approve it, exactly as in the CLI: a paid-run approval
// is not an approval of what the model will ask to run. It judges the result
// with its own oracle: the tests must pass when the
// harness runs them itself, and the test files and the user's pre-existing
// change must be byte-identical. It writes a JSON report with every request id
// and the receipts the server returned for them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const dist = new URL("../dist/", import.meta.url);
const { Runner } = await import(new URL("agent.js", dist));
const { Gateway } = await import(new URL("gateway.js", dist));
const { Journal } = await import(new URL("session.js", dist));
const { Workspace } = await import(new URL("workspace.js", dist));
const { createOutput } = await import(new URL("display.js", dist));
const { resolveEndpoint } = await import(new URL("config.js", dist));
const { readKey } = await import(new URL("auth.js", dist));
const { sessionCost } = await import(new URL("main.js", dist));
const { isInteractive, terminalPrompter } = await import(new URL("interactive.js", dist));
if (!isInteractive()) throw new Error("Run this in a terminal: each patch and command needs your approval.");

const { values } = parseArgs({ options: { endpoint: { type: "string" }, model: { type: "string" }, "max-requests": { type: "string" } } });
if (!values.endpoint || !values.model) throw new Error("--endpoint and --model are required");
const maxRequests = Number(values["max-requests"] ?? 12);
const endpoint = resolveEndpoint({ endpoint: values.endpoint }, { ...process.env, TOMVERSE_ENDPOINT: "" });
const key = await readKey();
const gateway = new Gateway(endpoint, key);
const usage = await gateway.usage(1);
if (usage.key?.credit_cap == null) throw new Error("Refusing: use a key with a credit cap for a paid check.");
const catalog = (await gateway.models()).filter((m) => m.tools && m.protocols.includes("chat_completions"));
const model = catalog.find((m) => m.id === values.model);
if (!model) throw new Error(`${values.model} is not offered to this key.`);

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Each scenario's synthetic repository is a folder in real-model-fixtures/,
// copied with LF line endings (real files, so the repository's import
// analysis can follow what they import).
const copyFixture = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) {
            mkdirSync(target, { recursive: true });
            copyFixture(source, target);
        } else writeFileSync(target, readFileSync(source, "utf8").replaceAll("\r\n", "\n"));
    }
};
const repo = (name) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tvcli-real-")));
    copyFixture(fileURLToPath(new URL(`./real-model-fixtures/${name}/`, import.meta.url)), root);
    return root;
};
const nodeTest = (root, file) => spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" }).status === 0;
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "tvcli-real-home-")));
// The CLI's own terminal prompter: the person decides each action.
const prompter = terminalPrompter();
const log = [];
const output = createOutput(false, { out: { write: (s) => (process.stdout.write(s), true) }, err: { write: (s) => (log.push(s), process.stderr.write(s), true) } });

const newRunner = (root, journal) =>
    new Runner({ gateway, journal, workspace: new Workspace(root), output, prompter, catalog, commandEnv: [], instructions: null });
const newJournal = (root) =>
    Journal.create(home, {
        workspace: { root },
        endpointOrigin: endpoint.origin,
        keyPrefix: key.slice(0, 12),
        readOnly: false,
        model: { requested: model.id, pinned: model.id === "smart-adaptive" ? null : model.id, pinnedFrom: model.id === "smart-adaptive" ? null : "user", contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens },
        limits: { maxRequests, timeoutMs: 15 * 60_000, commandTimeoutMs: 120_000 },
    });

const results = [];
const record = async (name, journal, checks) => {
    const cost = await sessionCost(gateway, journal);
    results.push({
        scenario: name,
        model: journal.state.model,
        status: journal.state.status,
        checks,
        pass: Object.values(checks).every(Boolean),
        requests: journal.state.generations.map((g) => ({ seq: g.seq, purpose: g.purpose, requestId: g.requestId ?? null, state: g.state, receipt: g.receipt ?? null })),
        cost,
    });
};

// 1. A single failing test.
{
    const root = repo("single");
    const testHash = sha(join(root, "test.js"));
    const journal = newJournal(root);
    const outcome = await newRunner(root, journal).runTask("node test.js fails. Fix the code (not the test) and run the test to confirm.");
    await record("single bug fix", journal, { outcome: outcome === "success", testUnchanged: sha(join(root, "test.js")) === testHash, testPasses: nodeTest(root, "test.js") });
    journal.release();
}

// 2. Several files, with the user's own uncommitted change kept.
{
    const root = repo("multi");
    const hashes = { test: sha(join(root, "test.js")), notes: sha(join(root, "NOTES.md")) };
    const journal = newJournal(root);
    const outcome = await newRunner(root, journal).runTask("node test.js reports failures. Fix every failing function without editing test.js or NOTES.md, then run the test.");
    await record("multiple files, user change kept", journal, {
        outcome: outcome === "success",
        testUnchanged: sha(join(root, "test.js")) === hashes.test,
        userChangeKept: sha(join(root, "NOTES.md")) === hashes.notes,
        testPasses: nodeTest(root, "test.js"),
        filesChanged: journal.state.changes.filter((c) => c.state === "applied").length >= 2,
    });
    journal.release();
}

// 3. Compact, close, resume, and a follow-up task; earlier commands are not run again.
{
    const root = repo("resume");
    const journal = newJournal(root);
    const first = await newRunner(root, journal).runTask("Fix calc.js so node test.js passes; run it.");
    const compacted = await newRunner(root, journal).maybeCompact(true);
    const commandsBefore = journal.state.tools.filter((t) => t.toolName === "run_command").map((t) => t.toolCallId);
    const id = journal.state.id;
    journal.release();
    const resumed = Journal.open(home, id);
    const second = await newRunner(root, resumed).runTask("Now add sub(a, b) to calc.js and run node test.js again.");
    const commandsAfter = resumed.state.tools.filter((t) => t.toolName === "run_command");
    const { sub } = await import(`${new URL(`file:///${join(root, "calc.js").replaceAll("\\", "/")}`).href}?t=${Date.now()}`);
    await record("compact, resume, follow-up", resumed, {
        firstOutcome: first === "success",
        compacted: compacted === "compacted",
        secondOutcome: second === "success",
        subWorks: typeof sub === "function" && sub(5, 3) === 2,
        testPasses: nodeTest(root, "test.js"),
        earlierCommandsNotRerun: commandsBefore.every((idBefore) => commandsAfter.filter((t) => t.toolCallId === idBefore).length === 1),
    });
    resumed.release();
}

const reportPath = join(home, "real-model-report.json");
writeFileSync(reportPath, JSON.stringify({ endpoint: endpoint.origin, model: model.id, provider: model.provider, platform: `${process.platform} ${process.arch} node ${process.versions.node}`, at: new Date().toISOString(), results }, null, 2));
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.scenario}  ${JSON.stringify(r.checks)}  credits ${r.cost.charged}${r.cost.held ? ` (+${r.cost.held} held)` : ""}${r.cost.unknown.length ? ` unknown #${r.cost.unknown.join(",")}` : ""}`);
console.log(`Report: ${reportPath}`);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
