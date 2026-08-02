import assert from "node:assert/strict";
import { test } from "node:test";
import {
    concurrencyRejectionDetails,
    concurrencyRejectionMessage,
    CONCURRENCY_RETRY_AFTER_SECONDS,
    DEFAULT_GUEST_CONCURRENCY,
    DEFAULT_IP_CONCURRENCY_CEILING,
    DEFAULT_LEASE_TTL_SECONDS,
    IP_CONCURRENCY_EXCEEDED,
    IP_CONCURRENCY_LAYER,
    leaseHeartbeatIntervalMs,
    MAX_LEASE_TTL_SECONDS,
    MIN_LEASE_TTL_SECONDS,
    resolveAdmissionTtlSeconds,
    resolveChatConcurrencyPlan,
    resolveLeaseTtlSeconds,
    SUBJECT_CONCURRENCY_EXCEEDED,
    SUBJECT_CONCURRENCY_LAYER,
} from "../lib/chatConcurrencyCore.ts";

const guest = (subject, ip) => ({
    kind: "guest",
    subjectKey: `guest:${subject}`,
    ipKey: `ip:${ip}`,
});

const user = (id, ip) => ({
    kind: "user",
    subjectKey: `user:${id}`,
    ipKey: `ip:${ip}`,
});

test("a guest's own concurrency limit is keyed by the guest subject, never the IP", () => {
    const plan = resolveChatConcurrencyPlan(guest("alice", "203-0-113-7"), {});
    assert.equal(plan.subject.key, "guest:alice");
    assert.equal(plan.subject.limit, DEFAULT_GUEST_CONCURRENCY);
    assert.equal(plan.subject.errorCode, SUBJECT_CONCURRENCY_EXCEEDED);
    assert.equal(plan.subject.limitLayer, SUBJECT_CONCURRENCY_LAYER);
    assert.equal(plan.subject.limitScope, "guest_concurrency");
});

test("two guests behind one NAT get separate subject scopes at the same IP", () => {
    const first = resolveChatConcurrencyPlan(guest("alice", "shared-nat"), {});
    const second = resolveChatConcurrencyPlan(guest("bob", "shared-nat"), {});

    assert.notEqual(first.subject.key, second.subject.key);
    assert.equal(first.subject.limit, second.subject.limit);
    // The shared aggregate ceiling is the only thing they have in common, and
    // it is far above either one's own allowance.
    assert.equal(first.ip?.key, second.ip?.key);
    assert.ok(first.ip.limit > first.subject.limit);
});

test("the IP scope is an aggregate abuse ceiling with its own code and layer", () => {
    const plan = resolveChatConcurrencyPlan(guest("alice", "nat"), {});
    assert.equal(plan.ip?.limit, DEFAULT_IP_CONCURRENCY_CEILING);
    assert.equal(plan.ip?.errorCode, IP_CONCURRENCY_EXCEEDED);
    assert.equal(plan.ip?.limitLayer, IP_CONCURRENCY_LAYER);
    assert.equal(plan.ip?.limitScope, "ip_concurrency");
    assert.notEqual(plan.ip?.errorCode, plan.subject.errorCode);
    assert.notEqual(plan.ip?.limitLayer, plan.subject.limitLayer);
});

test("signed-in users have no IP concurrency scope -- the account is the unit", () => {
    const plan = resolveChatConcurrencyPlan(user("u1", "nat"), {});
    assert.equal(plan.ip, null);
    assert.equal(plan.subject.key, "user:u1");
    assert.equal(plan.subject.limitScope, "user_concurrency");
});

test("an IP ceiling configured below the per-guest limit is raised to it", () => {
    const plan = resolveChatConcurrencyPlan(guest("alice", "nat"), {
        CHAT_GUEST_CONCURRENT: "3",
        CHAT_IP_CONCURRENT: "1",
    });
    // Otherwise the aggregate scope would refuse a single guest's own third
    // model -- the exact defect the split exists to remove.
    assert.equal(plan.ip?.limit, 3);
    assert.equal(plan.ipCeilingClamped, true);
});

test("environment overrides are read, and nonsense falls back to the default", () => {
    assert.equal(
        resolveChatConcurrencyPlan(guest("a", "b"), {
            CHAT_GUEST_CONCURRENT: "5",
        }).subject.limit,
        5
    );
    for (const value of ["0", "-2", "abc", "", undefined]) {
        assert.equal(
            resolveChatConcurrencyPlan(guest("a", "b"), {
                CHAT_GUEST_CONCURRENT: value,
            }).subject.limit,
            DEFAULT_GUEST_CONCURRENCY
        );
    }
});

test("the two rejections say different things and neither mentions credits", () => {
    const own = concurrencyRejectionMessage("subject");
    const network = concurrencyRejectionMessage("ip");
    assert.notEqual(own, network);
    for (const message of [own, network]) {
        assert.doesNotMatch(message, /credit|plan|budget|USD|\$/i);
    }
    assert.match(own, /already being generated/i);
    assert.match(network, /network/i);
});

test("rejection details carry the scope and counts, and no key or address", () => {
    const plan = resolveChatConcurrencyPlan(guest("alice", "nat"), {});
    const details = concurrencyRejectionDetails(plan.subject, 3, 1);
    assert.deepEqual(details, {
        scope: "guest_concurrency",
        limitLayer: SUBJECT_CONCURRENCY_LAYER,
        activeRequests: 3,
        requestedSlots: 1,
        concurrentLimit: DEFAULT_GUEST_CONCURRENCY,
    });
    assert.equal(JSON.stringify(details).includes("guest:alice"), false);
    assert.equal(JSON.stringify(details).includes("nat"), false);
});

test("the retry-after is a positive number of seconds", () => {
    assert.ok(CONCURRENCY_RETRY_AFTER_SECONDS > 0);
    assert.ok(Number.isSafeInteger(CONCURRENCY_RETRY_AFTER_SECONDS));
});

test("the lease TTL is renewable-length and clamped at both ends", () => {
    assert.equal(resolveLeaseTtlSeconds({}), DEFAULT_LEASE_TTL_SECONDS);
    assert.equal(
        resolveLeaseTtlSeconds({ CHAT_LEASE_TTL_SECONDS: "5" }),
        MIN_LEASE_TTL_SECONDS
    );
    assert.equal(
        resolveLeaseTtlSeconds({ CHAT_LEASE_TTL_SECONDS: "999999" }),
        MAX_LEASE_TTL_SECONDS
    );
    // The reported failure was a healthy stream still writing at 125s under a
    // flat 120s lease. A renewal, not a bigger constant, is what fixes it --
    // so the default stays modest and the heartbeat runs well inside it.
    assert.ok(leaseHeartbeatIntervalMs(DEFAULT_LEASE_TTL_SECONDS) * 3 <=
        DEFAULT_LEASE_TTL_SECONDS * 1000);
    assert.ok(leaseHeartbeatIntervalMs(DEFAULT_LEASE_TTL_SECONDS) >= 10_000);
});

test("an unclaimed admission slot is held for far less than a stream lease", () => {
    assert.ok(resolveAdmissionTtlSeconds({}) < resolveLeaseTtlSeconds({}));
    assert.equal(resolveAdmissionTtlSeconds({ CHAT_ADMISSION_TTL_SECONDS: "1" }), 15);
    assert.equal(
        resolveAdmissionTtlSeconds({ CHAT_ADMISSION_TTL_SECONDS: "100000" }),
        300
    );
});
