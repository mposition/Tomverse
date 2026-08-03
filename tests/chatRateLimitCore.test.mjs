import assert from "node:assert/strict";
import test from "node:test";

import {
    CHAT_RATE_LIMITED,
    DEFAULT_IP_PER_MINUTE,
    IP_RATE_LIMIT_LAYER,
    ipRateScope,
    rateLimitRejectionDetails,
    rateLimitRejectionMessage,
    resolveIpPerMinuteLimit,
    retryAfterSecondsFromResponse,
    SUBJECT_RATE_LIMIT_LAYER,
    subjectRateScope,
} from "../lib/chatRateLimitCore.ts";

/**
 * The arithmetic and the vocabulary of a per-minute rate rejection.
 *
 * The production report behind this file: a three-model comparison whose
 * caller had three of five minute units left passed a read-only preflight
 * check, ran two panels and lost the third to a 429. The database side of the
 * fix is in tests/integration/chat-rate-limit.db.test.ts; what is pinned here
 * is that a rate rejection can be told apart from a credit one by anybody
 * reading the decision log, and that the countdown it hands the client is
 * always something a person can act on.
 */

test("a subject rate limit is its own layer, never an entitlement", () => {
    const guest = subjectRateScope("guest", "guest:hashed", 5);
    const user = subjectRateScope("user", "user:hashed", 20);

    assert.equal(guest.limitLayer, SUBJECT_RATE_LIMIT_LAYER);
    assert.equal(user.limitLayer, SUBJECT_RATE_LIMIT_LAYER);
    // Credits and cost own these two names; a rate limit must not borrow them.
    for (const scope of [guest, user]) {
        assert.notEqual(scope.limitLayer, "entitlement");
        assert.notEqual(scope.limitLayer, "operational_guardrail");
        // Nor concurrency's: "you are sending too fast" and "your own answer is
        // still running" are different situations with different waits.
        assert.notEqual(scope.limitLayer, "concurrency");
    }
});

test("subject and IP rejections are distinguishable in diagnostics", () => {
    const subject = subjectRateScope("guest", "guest:hashed", 5);
    const ip = ipRateScope("ip:hashed", 40);

    assert.equal(subject.limitScope, "guest_rate_minute");
    assert.equal(subjectRateScope("user", "user:hashed", 20).limitScope, "user_rate_minute");
    assert.equal(ip.limitScope, "ip_rate_minute");
    assert.notEqual(subject.limitScope, ip.limitScope);
    // The aggregate anonymous ceiling shares its layer with IP concurrency,
    // which is the same kind of decision about the same kind of scope.
    assert.equal(ip.limitLayer, IP_RATE_LIMIT_LAYER);
    assert.equal(ip.limitLayer, "operational_admission");
});

test("the two rejection sentences say different things, and neither mentions credits", () => {
    const subject = rateLimitRejectionMessage("subject");
    const ip = rateLimitRejectionMessage("ip");

    assert.notEqual(subject, ip);
    assert.match(ip, /network/i);
    for (const message of [subject, ip]) {
        assert.doesNotMatch(message, /credit|plan|upgrade|budget|\$/i);
    }
});

test("rejection details carry a positive wait and a future reset", () => {
    const scope = subjectRateScope("guest", "guest:hashed", 5);
    const resetAt = new Date("2026-08-02T10:31:00.000Z");
    const details = rateLimitRejectionDetails(scope, {
        usedRequests: 3,
        requestedRequests: 3,
        retryAfterSeconds: 6,
        resetAt,
    });

    assert.equal(details.scope, "guest_rate_minute");
    assert.equal(details.limitLayer, "rate_limit");
    assert.equal(details.retryAfterSeconds, 6);
    assert.equal(details.requestedRequests, 3);
    assert.equal(details.availableRequests, 2);
    assert.equal(details.rateLimit, 5);
    assert.equal(details.resetAt, resetAt.toISOString());
    // Nothing internal: publicChatErrorDetails only strips `internal*`, so a
    // field named here reaches the browser.
    for (const key of Object.keys(details)) {
        assert.doesNotMatch(key, /^internal/);
    }
});

test("a wait is never rounded down to zero", () => {
    const scope = ipRateScope("ip:hashed", 40);
    const details = rateLimitRejectionDetails(scope, {
        usedRequests: 40,
        requestedRequests: 3,
        // The tail of a minute window: a truthful 0.4s would count down from
        // zero, which reads as a broken dialog rather than a short wait.
        retryAfterSeconds: 0.4,
        resetAt: new Date("2026-08-02T10:31:00.000Z"),
    });

    assert.equal(details.retryAfterSeconds, 1);
    assert.equal(details.availableRequests, 0);
});

test("available requests never go negative when a bucket is over its limit", () => {
    const scope = subjectRateScope("user", "user:hashed", 20);
    const details = rateLimitRejectionDetails(scope, {
        usedRequests: 25,
        requestedRequests: 3,
        retryAfterSeconds: 12,
        resetAt: new Date("2026-08-02T10:31:00.000Z"),
    });

    assert.equal(details.availableRequests, 0);
});

test("the IP ceiling reads its own environment variable and defaults to 40", () => {
    assert.equal(resolveIpPerMinuteLimit({}), DEFAULT_IP_PER_MINUTE);
    assert.equal(resolveIpPerMinuteLimit({}), 40);
    assert.equal(resolveIpPerMinuteLimit({ CHAT_IP_PER_MINUTE: "12" }), 12);
    // Nonsense configuration falls back rather than removing the protection.
    for (const value of ["0", "-5", "abc", "", "1.5"]) {
        assert.equal(
            resolveIpPerMinuteLimit({ CHAT_IP_PER_MINUTE: value }),
            DEFAULT_IP_PER_MINUTE
        );
    }
});

test("the client reads the wait from the body, then the header, then a floor", () => {
    // The body wins: a proxy can rewrite a header, and the body is what the
    // rest of the rejection was built from.
    assert.equal(
        retryAfterSecondsFromResponse("30", { retryAfterSeconds: 6 }),
        6
    );
    assert.equal(retryAfterSecondsFromResponse("6", undefined), 6);
    assert.equal(retryAfterSecondsFromResponse("6", { scope: "ip_rate_minute" }), 6);
    // Neither present, or neither usable: a sane default rather than "0".
    assert.equal(retryAfterSecondsFromResponse(null, null), 5);
    assert.equal(retryAfterSecondsFromResponse("", {}), 5);
    assert.equal(retryAfterSecondsFromResponse("not-a-number", {}), 5);
    assert.equal(retryAfterSecondsFromResponse("0", {}), 5);
    assert.equal(retryAfterSecondsFromResponse("-3", {}), 5);
    // Fractions round up, so the countdown never ends before the window does.
    assert.equal(retryAfterSecondsFromResponse(null, { retryAfterSeconds: 5.2 }), 6);
});

test("the rejection code is the one the client already switches on", () => {
    assert.equal(CHAT_RATE_LIMITED, "CHAT_RATE_LIMITED");
});
