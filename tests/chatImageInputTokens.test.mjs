import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { NATIVE_ATTACHMENT_ESTIMATED_TOKENS } from "../lib/chatAttachmentTokens.ts";
import {
    IMAGE_INPUT_TOKEN_RULES,
    estimateImageInputTokens,
    maxImageInputTokens,
    readImageDimensions,
    splitPreflightImageTokens,
} from "../lib/chatImageInputTokens.ts";
import { countableChatErrorDetails } from "../lib/chatRequestRejectionLog.ts";
import { ChatAccessError, createChatBudget } from "../lib/chatSecurity.ts";
import { createTokenEstimateAccumulator } from "../lib/chatTokenEstimate.ts";
import { getModel } from "../lib/models.ts";

/**
 * Why an image no longer counts as 16,000 tokens against the input limit.
 *
 * A guest sent one phone screenshot to GPT-5.4 mini and was told the chat was
 * too long: the flat allowance alone was 16,000, the guest ceiling is 16,000,
 * and the question itself tipped it over. The provider would have read about
 * 3,500 tokens. The limit now reads the image's size; the rest of the
 * allowance still reserves and charges, so nothing about cost moved.
 */

const PHONE_SCREENSHOT = { width: 1170, height: 2532 };

const encode = (format, width, height, options = {}) =>
    sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 40, g: 90, b: 160 },
        },
    })
        .toFormat(format, options)
        .toBuffer();

test("dimensions are read from every format the normalizer can emit", async () => {
    for (const [format, options] of [
        ["png", {}],
        ["jpeg", {}],
        ["jpeg", { progressive: true }],
        ["webp", {}],
        ["webp", { lossless: true }],
        ["gif", {}],
    ]) {
        const bytes = await encode(format, 1170, 2532, options);
        assert.deepEqual(
            readImageDimensions(new Uint8Array(bytes)),
            PHONE_SCREENSHOT,
            `${format} ${JSON.stringify(options)}`
        );
    }
});

test("an extended WebP header is read too", async () => {
    // VP8X is what a WebP with alpha is written as.
    const bytes = await sharp({
        create: {
            width: 640,
            height: 480,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0.5 },
        },
    })
        .webp()
        .toBuffer();
    assert.deepEqual(readImageDimensions(new Uint8Array(bytes)), {
        width: 640,
        height: 480,
    });
});

test("bytes that are not a readable image header give no dimensions", async () => {
    const png = await encode("png", 100, 100);
    const jpeg = await encode("jpeg", 100, 100);
    for (const bytes of [
        new Uint8Array(0),
        new TextEncoder().encode("not an image at all"),
        new Uint8Array(png.subarray(0, 20)),
        // A JPEG cut off before its frame header.
        new Uint8Array(jpeg.subarray(0, 6)),
    ]) {
        assert.equal(readImageDimensions(bytes), null);
    }
});

test("Anthropic's figures match the provider's own published table", () => {
    // platform.claude.com/docs/en/build-with-claude/vision, high-resolution tier.
    assert.equal(
        estimateImageInputTokens("anthropic", { width: 1000, height: 1000 }),
        1_296
    );
    assert.equal(
        estimateImageInputTokens("anthropic", { width: 1920, height: 1080 }),
        2_691
    );
    assert.equal(
        estimateImageInputTokens("anthropic", { width: 3840, height: 2160 }),
        4_784
    );
});

test("OpenAI images are 32px patches times the family multiplier", () => {
    // ceil(1170/32) x ceil(2532/32) = 37 x 80 = 2,960 patches, x1.2.
    assert.equal(estimateImageInputTokens("openai", PHONE_SCREENSHOT), 3_552);
    // Over the patch budget, an image costs the budget.
    assert.equal(
        estimateImageInputTokens("openai", { width: 5_900, height: 5_900 }),
        12_000
    );
});

test("a fixed-count provider ignores size", () => {
    assert.equal(estimateImageInputTokens("google", PHONE_SCREENSHOT), 2_240);
    assert.equal(estimateImageInputTokens("google", null), 2_240);
});

test("anything unmeasured keeps the flat allowance", () => {
    // No published formula, or no dimensions: the old figure, not a guess.
    assert.equal(
        estimateImageInputTokens("xai", PHONE_SCREENSHOT),
        NATIVE_ATTACHMENT_ESTIMATED_TOKENS
    );
    assert.equal(
        estimateImageInputTokens("openai", null),
        NATIVE_ATTACHMENT_ESTIMATED_TOKENS
    );
    assert.equal(
        estimateImageInputTokens("anthropic", { width: 0, height: 10 }),
        NATIVE_ATTACHMENT_ESTIMATED_TOKENS
    );
});

test("no estimate ever exceeds the flat allowance or its provider's ceiling", () => {
    const providers = [...Object.keys(IMAGE_INPUT_TOKEN_RULES), "mistral"];
    const sizes = [1, 27, 28, 29, 512, 1024, 2000, 2576, 4000, 6000, 16_384];
    for (const provider of providers) {
        const ceiling = maxImageInputTokens(provider);
        assert.ok(ceiling <= NATIVE_ATTACHMENT_ESTIMATED_TOKENS);
        for (const width of sizes) {
            for (const height of sizes) {
                const tokens = estimateImageInputTokens(provider, {
                    width,
                    height,
                });
                assert.ok(tokens >= 1);
                assert.ok(
                    tokens <= ceiling,
                    `${provider} ${width}x${height}: ${tokens} > ${ceiling}`
                );
            }
        }
    }
});

test("the preflight split always adds up to the flat allowance per image", () => {
    const attachments = [
        { mediaType: "image/png" },
        { mediaType: "image/jpeg" },
        { mediaType: "application/pdf" },
    ];
    for (const provider of ["openai", "anthropic", "google", "xai"]) {
        const split = splitPreflightImageTokens(provider, attachments);
        assert.equal(
            split.limitTokens + split.reservationOnlyInputTokens,
            2 * NATIVE_ATTACHMENT_ESTIMATED_TOKENS
        );
        assert.equal(split.limitTokens, 2 * maxImageInputTokens(provider));
    }
});

const GUEST_MODEL = getModel("gpt-5-4-mini");

const breakdownOf = (text, opaqueTokens) =>
    createTokenEstimateAccumulator()
        .addText(text)
        .addTokens(opaqueTokens)
        .breakdown();

test("the reported guest turn now fits: one screenshot and a question", () => {
    const question = "이 화면에서 무엇이 잘못됐는지 알려주세요.";
    const imageTokens = estimateImageInputTokens(
        GUEST_MODEL.provider,
        PHONE_SCREENSHOT
    );

    // Before: the flat allowance counted against a 16,000 ceiling.
    assert.throws(
        () =>
            createChatBudget(
                "guest",
                GUEST_MODEL,
                breakdownOf(question, NATIVE_ATTACHMENT_ESTIMATED_TOKENS)
            ),
        (error) =>
            error instanceof ChatAccessError &&
            error.code === "CHAT_INPUT_TOKEN_LIMIT"
    );

    // After: the measured size counts, and the rest only reserves.
    const budget = createChatBudget(
        "guest",
        GUEST_MODEL,
        breakdownOf(question, imageTokens),
        {
            reservationOnlyInputTokens:
                NATIVE_ATTACHMENT_ESTIMATED_TOKENS - imageTokens,
        }
    );
    assert.ok(budget.inputTokens >= NATIVE_ATTACHMENT_ESTIMATED_TOKENS);
});

test("the allowance reserves and charges exactly what a counted image did", () => {
    // A signed-in turn, far from its ceiling, so neither side is clamped.
    const text = "Compare these two receipts.";
    const measured = [3_552, 1_296];
    const allowance =
        measured.length * NATIVE_ATTACHMENT_ESTIMATED_TOKENS -
        measured.reduce((sum, tokens) => sum + tokens, 0);

    const counted = createChatBudget(
        "user",
        GUEST_MODEL,
        breakdownOf(text, measured.length * NATIVE_ATTACHMENT_ESTIMATED_TOKENS)
    );
    const split = createChatBudget(
        "user",
        GUEST_MODEL,
        breakdownOf(text, measured[0] + measured[1]),
        { reservationOnlyInputTokens: allowance }
    );

    assert.equal(split.inputTokens, counted.inputTokens);
    assert.equal(split.usageCredits, counted.usageCredits);
});

test("the allowance never counts towards the input limit", () => {
    // Right at the guest ceiling on measured tokens, with an allowance that
    // would have been four images' worth over it.
    const ceiling = Number(process.env.CHAT_GUEST_MAX_INPUT_TOKENS) || 16_000;
    assert.doesNotThrow(() =>
        createChatBudget("guest", GUEST_MODEL, ceiling, {
            reservationOnlyInputTokens: 4 * NATIVE_ATTACHMENT_ESTIMATED_TOKENS,
        })
    );
    assert.throws(
        () => createChatBudget("guest", GUEST_MODEL, ceiling + 1),
        (error) => error instanceof ChatAccessError
    );
});

test("an input-limit refusal carries its numbers for the log, not the client", () => {
    let refusal;
    try {
        createChatBudget("guest", GUEST_MODEL, 20_000);
    } catch (error) {
        refusal = error;
    }
    assert.ok(refusal instanceof ChatAccessError);
    assert.equal(refusal.details.internalEstimatedInputTokens, 20_000);
    assert.equal(
        refusal.details.internalMaxInputTokens,
        Number(process.env.CHAT_GUEST_MAX_INPUT_TOKENS) || 16_000
    );
});

test("the rejection log copies numbers and withholds everything else", () => {
    assert.deepEqual(countableChatErrorDetails(undefined), {});
    assert.deepEqual(
        countableChatErrorDetails({
            internalEstimatedInputTokens: 20_000,
            resetAt: "2026-09-30T00:00:00.000Z",
            unavailableAttachmentNames: ["tax-return-2025.pdf"],
        }),
        {
            internalEstimatedInputTokens: 20_000,
            withheldDetailKeys: ["resetAt", "unavailableAttachmentNames"],
        }
    );
});
