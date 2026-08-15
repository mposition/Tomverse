import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * `/api/admin/memory-extraction/revocations`.
 *
 * The route that gives policy §12.1 its "in the Admin Console, by an approved
 * operator, audit-logged" half. Four things it must get right, and every one
 * of them is a property the hand-written `UPDATE` it replaces did not have.
 *
 * A non-admin gets 404 rather than 403, like the rest of the console. A reader
 * without `ops:write` gets 403 on the write and still gets the read, because
 * seeing what is revoked is not the same permission as changing it. A request
 * that would round-trip as "revoke everything" is refused with the reason
 * rather than stored. And the audit entry is written before the change, so an
 * attempt that fails part-way still leaves a record of who tried.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type World = {
    session: unknown;
    isAdmin: boolean;
    canWrite: boolean;
    stored: unknown;
    writes: unknown[];
    audits: Array<{ action: string; metadata: unknown }>;
    reauthentications: number;
};

let world: World = {
    session: null,
    isAdmin: false,
    canWrite: false,
    stored: { kind: "none" },
    writes: [],
    audits: [],
    reauthentications: 0,
};
let installed = false;

async function loadRoute(): Promise<{
    GET: (request: Request) => Promise<Response>;
    PUT: (request: Request) => Promise<Response>;
}> {
    if (!installed) {
        installed = true;
        mock.module(mod("node_modules/next-auth/next/index.js"), {
            namedExports: { getServerSession: async () => world.session },
        });
        mock.module(mod("lib/adminAuth.ts"), {
            namedExports: {
                isAdminSession: () => world.isAdmin,
                hasAdminPermission: () => world.canWrite,
            },
        });
        mock.module(mod("lib/adminAudit.ts"), {
            namedExports: {
                writeAdminAuditLog: async (entry: {
                    action: string;
                    metadata: unknown;
                }) => {
                    world.audits.push({
                        action: entry.action,
                        metadata: entry.metadata,
                    });
                },
            },
        });
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const realReauthentication = require(
            resolve(ROOT, "lib/adminReauthentication.ts")
        ) as Record<string, unknown>;
        mock.module(mod("lib/adminReauthentication.ts"), {
            namedExports: {
                ...realReauthentication,
                assertRecentAdminAuthentication: async () => {
                    world.reauthentications += 1;
                },
            },
        });
        const realApiSecurity = require(
            resolve(ROOT, "lib/apiSecurity.ts")
        ) as Record<string, unknown>;
        mock.module(mod("lib/apiSecurity.ts"), {
            namedExports: {
                ...realApiSecurity,
                consumeApiRateLimit: async () => {},
            },
        });
        // The storage layer is replaced, but the *validation* is not: the real
        // `revokedPairsRequestProblems` still decides what may be stored, so a
        // refusal here is the refusal production performs.
        const memoryAccess = require(resolve(ROOT, "lib/memoryAccess.ts")) as {
            revokedPairsRequestProblems: (request: unknown) => string[];
            serializeRevokedPairs: (request: unknown) => string;
            parseRevokedPairs: (value: string) => unknown;
        };
        class MemoryRevocationRequestError extends Error {
            constructor(public readonly problems: string[]) {
                super("The revocation request cannot be stored as written.");
                this.name = "MemoryRevocationRequestError";
            }
        }
        mock.module(mod("lib/appSettings.ts"), {
            namedExports: {
                MemoryRevocationRequestError,
                getMemoryExtractionRevokedPairs: async () => world.stored,
                setMemoryExtractionRevokedPairs: async (request: unknown) => {
                    const problems =
                        memoryAccess.revokedPairsRequestProblems(request);
                    if (problems.length > 0) {
                        throw new MemoryRevocationRequestError(problems);
                    }
                    world.writes.push(request);
                    world.stored = memoryAccess.parseRevokedPairs(
                        memoryAccess.serializeRevokedPairs(request)
                    );
                    return world.stored;
                },
            },
        });
    }
    return import(mod("app/api/admin/memory-extraction/revocations/route.ts"));
}

const URL_ = "https://tomverse.app/api/admin/memory-extraction/revocations";

const put = (body: unknown) =>
    new Request(URL_, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

const reset = (overrides: Partial<World> = {}) => {
    world = {
        session: { user: { id: "admin_1", email: "ops@tomverse.app" } },
        isAdmin: true,
        canWrite: true,
        stored: { kind: "none" },
        writes: [],
        audits: [],
        reauthentications: 0,
        ...overrides,
    };
};

test("a signed-out visitor gets 404 on both halves, and nothing is written", async () => {
    reset({ session: null, isAdmin: false, canWrite: false });
    const { GET, PUT } = await loadRoute();
    assert.equal((await GET(new Request(URL_))).status, 404);
    assert.equal(
        (await PUT(put({ mode: "all", reason: "test" }))).status,
        404
    );
    assert.equal(world.writes.length, 0);
    assert.equal(world.audits.length, 0);
});

test("a reader without ops:write can see the revocations but not change them", async () => {
    // Two different permissions. An operator who cannot act still needs to know
    // whether extraction is stopped -- that is the first question during an
    // incident, and answering it must not require the ability to make it worse.
    reset({ canWrite: false });
    const { GET, PUT } = await loadRoute();

    const read = await GET(new Request(URL_));
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.canWrite, false);
    assert.ok(Array.isArray(body.register));

    const write = await PUT(put({ mode: "all", reason: "test" }));
    assert.equal(write.status, 403);
    assert.equal(world.writes.length, 0);
    assert.equal(world.reauthentications, 0);
});

test("a stored revocation is reported with its labels", async () => {
    reset();
    const { GET, PUT } = await loadRoute();
    const response = await PUT(
        put({
            mode: "pairs",
            labels: ["gpt-5-6-luna::mem-extract-v1"],
            reason: "elevated false-accept rate on ko",
        })
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).revoked, {
        kind: "revoked",
        pairs: ["gpt-5-6-luna::mem-extract-v1"],
    });

    const read = await (await GET(new Request(URL_))).json();
    assert.deepEqual(read.revoked.pairs, ["gpt-5-6-luna::mem-extract-v1"]);
});

test("a label that would revoke everything is refused with the reason, not stored", async () => {
    reset();
    const { PUT } = await loadRoute();
    const response = await PUT(
        put({
            mode: "pairs",
            labels: ["gpt-5-6-luna::mem-extract-v1", "typo-without-separator"],
            reason: "stopping one pair",
        })
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_REVOCATION_REQUEST");
    assert.equal(body.problems.length, 1);
    assert.match(body.problems[0], /typo-without-separator/);
    assert.equal(world.writes.length, 0);
});

test("an unregistered pair is stored and reported, not refused", async () => {
    // Both a legitimate emergency action -- the register may no longer list a
    // pair that is still running somewhere -- and what a typo looks like. The
    // operator is told which they did rather than blocked from doing either.
    reset();
    const { PUT } = await loadRoute();
    const response = await PUT(
        put({
            mode: "pairs",
            labels: ["retired-model::mem-extract-v1"],
            reason: "pulled after the register entry was removed",
        })
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).unknownLabels, [
        "retired-model::mem-extract-v1",
    ]);
    assert.equal(world.writes.length, 1);
});

test("a reason is required, and no reason means no write", async () => {
    reset();
    const { PUT } = await loadRoute();
    const response = await PUT(put({ mode: "all" }));
    assert.equal(response.status >= 400, true, `got ${response.status}`);
    assert.equal(world.writes.length, 0);
});

test("the attempt is audited before the change, and the outcome after it", async () => {
    // An update that dies half-way must still say who tried. One entry written
    // afterwards would lose exactly the attempt worth knowing about.
    reset();
    const { PUT } = await loadRoute();
    await PUT(put({ mode: "all", reason: "provider incident" }));

    assert.deepEqual(
        world.audits.map((entry) => entry.action),
        [
            "memory_extraction.revocations.update_started",
            "memory_extraction.revocations.updated",
        ]
    );
    const outcome = world.audits[1].metadata as {
        reason: string;
        after: { kind: string; reason?: string };
    };
    assert.equal(outcome.reason, "provider incident");
    assert.equal(outcome.after.kind, "revoke_all");
    assert.equal(
        outcome.after.reason,
        "operator",
        "the audit must record a deliberate stop as one, not as a corrupted row"
    );
});

test("a write reauthenticates, and a read does not", async () => {
    reset();
    const { GET, PUT } = await loadRoute();
    await GET(new Request(URL_));
    assert.equal(world.reauthentications, 0);
    await PUT(put({ mode: "none", reason: "incident closed" }));
    assert.equal(world.reauthentications, 1);
});
