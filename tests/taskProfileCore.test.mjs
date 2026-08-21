import assert from "node:assert/strict";
import test from "node:test";

import {
    TASK_KINDS,
    TASK_PROFILE_VERSION,
    buildTaskProfile,
} from "../lib/taskProfileCore.ts";

/**
 * The versioned task profile (delivery plan §6 step 1).
 *
 * Two kinds of test here, and the second matters more than the first. The
 * classification tests pin what the rules do today, and they will move as the
 * rules are tuned against a decision-grade set that does not exist yet. The
 * contract tests — content-free output, a recorded version, attachments
 * beating keywords — pin properties that must survive every future tuning,
 * because breaking one of those is a leak or an unexplainable routing
 * decision rather than a worse guess.
 */

const profile = (text, rest = {}) => buildTaskProfile({ text, ...rest });

test("every profile records the version that produced it", () => {
    // RoutingRun stores this next to the Router and Estimator versions. A
    // profile with no version is a routing decision nobody can attribute
    // afterwards, which is the reason the field exists at all.
    assert.equal(profile("hello").version, TASK_PROFILE_VERSION);
});

test("the profile carries no input text, anywhere", () => {
    // Routing policy §2: raw prompts are not copied into routing telemetry,
    // and a profile is recorded on every run. The tempting debugging aid —
    // "which phrase matched?" — is exactly the leak, so signals are fixed rule
    // names defined in the module and never anything from the input.
    const secret = "myuniquesecrettoken";
    const built = profile(
        `Please debug this ${secret} stack trace in one line`,
        { attachments: [{ name: `${secret}.pdf`, mediaType: "application/pdf" }] }
    );
    const serialised = JSON.stringify(built);
    assert.ok(
        !serialised.includes(secret),
        `profile leaked input text: ${serialised}`
    );
    for (const signal of built.signals) {
        assert.match(signal, /^[a-z]+:[a-z-]+$/, `signal is not a fixed name: ${signal}`);
    }
});

test("kind is always one of the declared vocabulary", () => {
    for (const text of ["", "   ", "안녕", "```js\nconst a = 1\n```", "translate this"]) {
        assert.ok(TASK_KINDS.includes(profile(text).kind), text);
    }
});

test("an empty turn is general with no confidence claimed", () => {
    const built = profile("");
    assert.equal(built.kind, "general");
    // "none" rather than "weak": no rule fired, so there is nothing to be
    // weakly confident about.
    assert.equal(built.kindConfidence, "none");
    assert.deepEqual(built.signals, []);
});

test("a fenced block is coding regardless of the prose around it", () => {
    const built = profile("Can you look at this?\n```python\nprint(1)\n```");
    assert.equal(built.kind, "coding");
    assert.ok(built.signals.includes("code:fence"));
});

test("a stack trace is coding even with no code words", () => {
    const built = profile(
        "무슨 뜻인가요?\nTraceback (most recent call last)\n  File a.py, line 2"
    );
    assert.equal(built.kind, "coding");
    assert.ok(built.signals.includes("code:stack-trace"));
});

test("two independent code signals read as strong, one as weak", () => {
    const weak = profile("이 정규식 좀 봐주세요");
    assert.equal(weak.kind, "coding");
    assert.equal(weak.kindConfidence, "weak");

    const strong = profile("```ts\nconst x = 1\n```\nrefactor this typescript");
    assert.equal(strong.kind, "coding");
    assert.equal(strong.kindConfidence, "strong");
});

test("an attached document outranks a keyword in the text", () => {
    // The attachment is a fact; the keyword is a reading of intent. A turn
    // that says "write" while carrying a contract is still a document turn.
    const built = profile("write something about this", {
        attachments: [{ name: "contract.pdf", mediaType: "application/pdf" }],
    });
    assert.equal(built.kind, "documents");
    assert.equal(built.hasDocumentInput, true);
});

test("an image attachment is not also counted as a document", () => {
    // An SVG is text/xml-ish and a screenshot has a filename; treating either
    // as a document would route a picture at a long-context model for nothing.
    for (const attachment of [
        { name: "shot.png", mediaType: "image/png" },
        { name: "diagram.svg", mediaType: "image/svg+xml" },
    ]) {
        const built = profile("what is this?", { attachments: [attachment] });
        assert.equal(built.hasImageInput, true, attachment.name);
        assert.equal(built.hasDocumentInput, false, attachment.name);
    }
});

test("current-information need is separate from the research kind", () => {
    // A one-line weather question needs fresh data and is not research; a
    // literature summary is research that may need nothing current. Collapsing
    // them would make the Router unable to ask either question.
    const weather = profile("오늘 서울 날씨 어때?");
    assert.equal(weather.needsCurrentInformation, true);
    assert.notEqual(weather.kind, "research");

    const research = profile("출처를 붙여서 이 주제를 정리해 주세요");
    assert.equal(research.kind, "research");
});

test("an explicit search request beats the heuristic and says so", () => {
    const built = profile("tell me about lighthouses", {
        webSearchRequested: true,
    });
    assert.equal(built.needsCurrentInformation, true);
    assert.ok(built.signals.includes("search:requested"));
    // The guess must not also be recorded: the user stated it, so attributing
    // the decision to a keyword rule would misreport why search ran.
    assert.ok(!built.signals.includes("search:recency-heuristic"));
});

test("a requested short answer is recognised, and short wins a tie", () => {
    assert.equal(profile("한 줄로 설명해 줘").expectedOutputLength, "short");
    assert.equal(profile("explain in detail").expectedOutputLength, "long");
    // Over-reserving output tokens spends credits the turn did not need; the
    // opposite mistake is the user asking for more.
    assert.equal(
        profile("자세히는 말고 한 줄로 요약만").expectedOutputLength,
        "short"
    );
});

test("a turn that says nothing about length lands on medium", () => {
    const built = profile("파이썬으로 정렬 알고리즘 알려줘");
    assert.equal(built.expectedOutputLength, "medium");
    assert.ok(!built.signals.some((signal) => signal.startsWith("length:")));
});

test("scripts are reported for tokenizer-stratified estimation", () => {
    assert.deepEqual(profile("hello world").scripts, ["latin"]);
    assert.deepEqual(profile("안녕하세요").scripts, ["cjk"]);
    assert.deepEqual(profile("안녕 world").scripts, ["cjk", "latin"]);
    assert.deepEqual(profile("12345").scripts, []);
});

test("script detection does not depend on how many times it has run", () => {
    // The CJK pattern is a global regex, so a shared lastIndex would make
    // every second call answer about where the previous one stopped.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.deepEqual(
            profile("한국어 문장입니다").scripts,
            ["cjk"],
            `attempt ${attempt}`
        );
    }
});

test("the same turn always profiles the same way", () => {
    // Deterministic is the property the shadow comparison in §6 step 3 rests
    // on: two runs over the same traffic have to be comparable.
    const text = "```sql\nSELECT 1 FROM t\n```\n출처도 알려줘, 자세히";
    assert.deepEqual(profile(text), profile(text));
});

test("translation is its own kind rather than writing", () => {
    const built = profile("이 문장을 영어로 번역해 줘");
    assert.equal(built.kind, "multilingual");
});

test("a plain writing request is writing", () => {
    const built = profile("블로그 글 초안 작성해 줘");
    assert.equal(built.kind, "writing");
});

test("missing and malformed input does not throw", () => {
    // This runs on every turn before anything else does. A profile that can
    // throw would turn a strange message into a failed request.
    assert.doesNotThrow(() => buildTaskProfile({ text: "" }));
    assert.doesNotThrow(() =>
        buildTaskProfile({ text: "x", attachments: [{}] })
    );
    assert.doesNotThrow(() =>
        buildTaskProfile({ text: "x", attachments: [{ name: undefined }] })
    );
});

// The v2 fix, and the thing it must not become.
//
// `needsCurrentInformation` drives the Router's web-search hard filter. Until
// v2 it was read through the composer's suggestion heuristic, whose
// four-character floor exists so the UI does not nag while somebody types --
// an anti-nagging rule sitting on a safety boundary. A two-character request
// for sources therefore recorded `false`, the filter never ran, and a model
// with no search path stayed eligible for a turn that had asked for sources.

test("an explicit source request needs the web however short it is", () => {
    for (const text of ["출처", "근거", "웹검색"]) {
        const built = profile(text);
        assert.equal(built.needsCurrentInformation, true, text);
        assert.equal(built.kind, "research", text);
        // Attributable: the flag says which of the three rules set it, so a
        // stated request is never reported as a guess about wording.
        assert.ok(built.signals.includes("search:source-intent"), text);
        assert.ok(!built.signals.includes("search:recency-heuristic"), text);
    }
});

test("a short ordinary turn still needs nothing", () => {
    const built = profile("hi");
    assert.equal(built.kind, "general");
    assert.equal(built.needsCurrentInformation, false);
    assert.equal(built.kindConfidence, "none");
});

test("softer recency wording keeps the floor it had", () => {
    // The fix is about stated intent. A bare "오늘" is a guess about what the
    // turn needs rather than something the person asked for, so widening it
    // stays a separate decision with its own evidence.
    assert.equal(profile("오늘 서울 날씨 어때?").needsCurrentInformation, true);
    assert.equal(profile("오늘").needsCurrentInformation, false);
});

// The rule this fix must NOT turn into: "the research kind implies a
// search-capable model". Document work that happens to be research-shaped
// would then be pushed onto search models for no reason.
test("summarising an attached paper needs no current information", () => {
    const built = profile("이 논문을 요약해 줘", {
        attachments: [{ name: "paper.pdf", mediaType: "application/pdf" }],
    });
    assert.equal(built.needsCurrentInformation, false);
    // And it is not even the research kind: an attachment is a fact and
    // outranks vocabulary, so this is document work. Which is the point --
    // nothing about "research-shaped" reaches the web-search filter.
    assert.equal(built.kind, "documents");
});

test("the two axes are read from one definition without becoming one axis", () => {
    // Independence is not symmetry. A turn that asked for sources is both
    // research-shaped and in need of the web, so `research` implies
    // `needsCurrentInformation` -- that is what the research kind is detected
    // by. The direction that must stay open is the other one, and these are
    // the turns that hold it open.
    const weather = profile("오늘 서울 날씨 어때?");
    assert.equal(weather.needsCurrentInformation, true);
    assert.notEqual(weather.kind, "research");

    const document = profile("이 계약서의 조항을 요약해 줘");
    assert.equal(document.kind, "documents");
    assert.equal(document.needsCurrentInformation, false);
});
