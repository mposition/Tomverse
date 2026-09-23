import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    ROUTING_FAILURE_RESULTS,
    credentialDisableWrite,
    routingFailureDisposition,
} from "../lib/routingFailureDisposition.ts";

const at = (result, overrides = {}) =>
    routingFailureDisposition({
        result,
        committed: false,
        sameDeploymentRetriesUsed: 0,
        ...overrides,
    });

test("each §11.2 row has one disposition, and an unknown result has none", () => {
    assert.equal(at("rate_limited").otherDeployment, "required");
    assert.equal(at("rate_limited").breaker, false);

    for (const result of ["server_error", "connection_error", "pre_commit_timeout", "transport_corruption"]) {
        assert.equal(at(result).breaker, true, result);
        assert.equal(at(result).otherDeployment, "no", result);
    }

    const unsupported = at("unsupported_request");
    assert.equal(unsupported.blindRetry, false);
    assert.equal(unsupported.otherDeployment, "no");
    assert.equal(unsupported.breaker, false);

    const credential = at("credential_rejected");
    assert.equal(credential.disableCredentialScope, true);
    assert.equal(credential.alert, true);
    assert.equal(credential.otherDeployment, "required");
    assert.equal(credential.breaker, false);
    assert.deepEqual(credentialDisableWrite(credential), { status: "disabled" });

    assert.equal(at("safety_refusal").otherDeployment, "forbidden");
    assert.equal(at("safety_refusal").breaker, false);

    assert.equal(at("not_a_result"), null);
    assert.equal(at("rate_limited", { committed: "yes" }), null);
    assert.equal(at("rate_limited", { sameDeploymentRetriesUsed: -1 }), null);
    assert.equal(at("rate_limited", { sameDeploymentRetriesUsed: 1.5 }), null);
});

test("malformed output retries the same deployment once, then may move", () => {
    const first = at("malformed_output");
    assert.equal(first.sameDeploymentRetry, true);
    assert.equal(first.otherDeployment, "no");
    assert.equal(first.qualityDrift, true);
    assert.equal(first.breaker, false);

    const spent = at("malformed_output", { sameDeploymentRetriesUsed: 1 });
    assert.equal(spent.sameDeploymentRetry, false);
    assert.equal(spent.otherDeployment, "permitted");

    const committed = at("malformed_output", { committed: true });
    assert.equal(committed.otherDeployment, "forbidden");
    assert.equal(committed.sameDeploymentRetry, false);
    assert.equal(committed.qualityDrift, true);
});

test("a post-commit stream failure does not reroute and names the finish reason", () => {
    assert.equal(at("post_commit_stream_failure"), null);
    const failure = at("post_commit_stream_failure", { committed: true });
    assert.equal(failure.finishReason, "upstream_error");
    assert.equal(failure.otherDeployment, "forbidden");
    assert.equal(failure.breaker, false);
});

test("only a credential rejection names a disable write", () => {
    for (const result of ROUTING_FAILURE_RESULTS) {
        const committed = result === "post_commit_stream_failure";
        const disposition = at(result, { committed });
        const write = credentialDisableWrite(disposition);
        if (result === "credential_rejected") {
            assert.deepEqual(write, { status: "disabled" });
        } else {
            assert.equal(write, null, result);
        }
    }
    assert.equal(credentialDisableWrite(null), null);
});

test("the request path does not import the failure disposition", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingFailureDisposition.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("routingFailureDisposition") ||
                source.includes("credentialDisableWrite")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
