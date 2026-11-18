import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner, type ApprovalView, type Prompter } from "../src/agent.js";
import { createOutput, type Output } from "../src/display.js";
import { Gateway } from "../src/gateway.js";
import { Journal } from "../src/session.js";
import { Workspace } from "../src/workspace.js";
import { TEST_KEY, type FakeGateway } from "./fakeGateway.js";

export const tempDir = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `tvcli-${prefix}-`)));

/** A tiny project with a failing test: sum() subtracts. */
export const makeRepo = (extra: Record<string, string> = {}) => {
    const root = tempDir("repo");
    writeFileSync(join(root, "sum.js"), "export function sum(a, b) {\n  return a - b;\n}\n");
    writeFileSync(
        join(root, "test.js"),
        'import { sum } from "./sum.js";\nif (sum(2, 3) !== 5) { console.error("FAIL sum(2,3)=" + sum(2, 3)); process.exit(1); }\nconsole.log("PASS");\n'
    );
    writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
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
