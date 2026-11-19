import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, type ApprovalView, type Prompter } from "../src/agent.js";
import { createOutput, type Output } from "../src/display.js";
import { Gateway } from "../src/gateway.js";
import { Journal } from "../src/session.js";
import { Workspace } from "../src/workspace.js";
import { TEST_KEY, type FakeGateway } from "./fakeGateway.js";

export const tempDir = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `tvcli-${prefix}-`)));

/**
 * Copies a fixture folder with LF line endings, whatever the checkout did to
 * them. The fixtures are real files rather than strings here, so the
 * repository's import analysis can follow what they import.
 */
export const copyFixture = (from: string, to: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) {
            mkdirSync(target, { recursive: true });
            copyFixture(source, target);
        } else writeFileSync(target, readFileSync(source, "utf8").replace(/\r\n/g, "\n"));
    }
};

/** A tiny project with a failing test: sum() subtracts (tests/fixtures/sum-repo). */
export const makeRepo = (extra: Record<string, string> = {}) => {
    const root = tempDir("repo");
    copyFixture(fileURLToPath(new URL("./fixtures/sum-repo/", import.meta.url)), root);
    for (const [path, content] of Object.entries(extra)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
};

export type Captured = { output: Output; err: string[]; out: string[] };

export const captureOutput = (json = false): Captured => {
    const err: string[] = [];
    const out: string[] = [];
    const output = createOutput(json, {
        out: { write: (s: string) => (out.push(s), true) } as never,
        err: { write: (s: string) => (err.push(s), true) } as never,
    });
    return { output, err, out };
};

export const scriptedPrompter = (answers: boolean[], seen: ApprovalView[] = []): Prompter => ({
    async approve(view) {
        seen.push(view);
        return answers.shift() ?? false;
    },
    async confirm() {
        return answers.shift() ?? false;
    },
});

export const makeRunner = async (
    gateway: FakeGateway,
    root: string,
    options: { prompter?: Prompter | null; home?: string | null; readOnly?: boolean; model?: string; maxRequests?: number; output?: Output; contextWindow?: number } = {}
) => {
    const endpoint = { base: gateway.base, origin: new URL(gateway.base).origin, basePath: "/api/v1" };
    const client = new Gateway(endpoint, TEST_KEY);
    const catalog = (await client.models()).filter((m) => m.tools);
    const modelId = options.model ?? "fake-coder";
    const model = catalog.find((m) => m.id === modelId)!;
    const journal = Journal.create(options.home === undefined ? tempDir("home") : options.home, {
        workspace: { root },
        endpointOrigin: endpoint.origin,
        keyPrefix: TEST_KEY.slice(0, 12),
        readOnly: options.readOnly ?? false,
        model: {
            requested: modelId,
            pinned: modelId === "smart-adaptive" ? null : modelId,
            pinnedFrom: modelId === "smart-adaptive" ? null : "user",
            contextWindowTokens: options.contextWindow ?? model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
        },
        limits: { maxRequests: options.maxRequests ?? 20, timeoutMs: 15 * 60_000, commandTimeoutMs: 120_000 },
    });
    if (options.contextWindow) for (const m of catalog) if (m.id === modelId) m.contextWindowTokens = options.contextWindow;
    const output = options.output ?? captureOutput().output;
    const runner = new Runner({ gateway: client, journal, workspace: new Workspace(root), output, prompter: options.prompter === undefined ? scriptedPrompter([]) : options.prompter, catalog, commandEnv: [], instructions: null });
    return { runner, journal, client };
};
