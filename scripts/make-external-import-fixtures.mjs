// Synthetic conversations.json fixtures for the external-import staging
// checklist. No personal data: every byte is generated here, so the files can
// be regenerated instead of being kept around after a verification run.
//
//   node scripts/make-external-import-fixtures.mjs --case c1 [--out FILE]
//   node scripts/make-external-import-fixtures.mjs --case c4 [--out FILE]
//
// c1 -- checklist "100,000 code point" item. One message over
//       maxStoredMessageCodePoints and under maxInboundMessageCodePoints, plus
//       a control conversation. The long message is built from fixed-width
//       blocks so the truncation boundary can be read straight off the stored
//       text rather than taken on trust; the script prints where it should
//       land.
//
// c4 -- checklist "new snapshot / lineage" item. The same two conversations
//       with one extra message appended to the control. `externalStableId` is
//       provider + userId + rawExternalConversationId (lib/externalImportDigest.ts),
//       so reusing the uuids keeps both in their existing lineage, while the
//       added message changes the conversation digest and makes that one a new
//       snapshot instead of a duplicate.
//
// Run c1 first and finalize it: c4 is only meaningful against an account that
// already holds the c1 conversations.
import { writeFileSync } from "node:fs";

const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

// Mirrors lib/externalImportLimits.ts. Duplicated rather than imported because
// this script is plain node and that module is TypeScript; the printed
// boundary is a prediction to check the running build against, so a drift
// between the two shows up as a failed comparison on screen.
const MAX_STORED_CODE_POINTS = 100_000;
const TRUNCATION_MARKER = "\n\n[[tomverse:truncated]]\n\n";
const HEAD_RATIO = 0.75;

const BLOCK_BODY = "-ABCDEFGHIJKL";
const BLOCK_WIDTH = 20;
const BLOCKS = 6000;

const codePoints = (value) => [...value].length;
const block = (n) => `${String(n).padStart(6, "0")}${BLOCK_BODY}\n`;

const longText = Array.from({ length: BLOCKS }, (_, index) =>
    block(index + 1)
).join("");
if (codePoints(longText) !== BLOCKS * BLOCK_WIDTH) {
    fail("block width drifted -- the printed boundary would be wrong");
}

const TRUNCATION_UUID = "c1-truncation-over-store-limit";
const CONTROL_UUID = "c1-control-no-truncation";

const message = (uuid, sender, text, createdAt) => ({
    uuid,
    sender,
    text,
    created_at: createdAt,
});

const truncationConversation = () => ({
    uuid: TRUNCATION_UUID,
    name: "C1 truncation - over store limit",
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
    chat_messages: [
        message(
            "c1-trunc-msg-1",
            "human",
            "C1 fixture: the next answer is 120,000 code points.",
            "2026-08-19T00:00:00.000Z"
        ),
        message("c1-trunc-msg-2", "assistant", longText, "2026-08-19T00:00:01.000Z"),
    ],
});

const controlConversation = (extraMessages = []) => ({
    uuid: CONTROL_UUID,
    name: "C1 control - no truncation",
    created_at: "2026-08-19T00:01:00.000Z",
    updated_at: extraMessages.length
        ? "2026-08-19T02:00:00.000Z"
        : "2026-08-19T00:01:00.000Z",
    chat_messages: [
        message(
            "c1-control-msg-1",
            "human",
            "C1 control conversation.",
            "2026-08-19T00:01:00.000Z"
        ),
        message(
            "c1-control-msg-2",
            "assistant",
            "Short enough to store verbatim.",
            "2026-08-19T00:01:01.000Z"
        ),
        ...extraMessages,
    ],
});

/**
 * What truncation should do to the c1 long message, from the constants above.
 * Note the parsed length is one code point short of the generated text: the
 * Claude adapter trims the message body, and the last block ends in a newline.
 */
const truncationBoundary = () => {
    const parsedLength = codePoints(longText.trim());
    const retained = MAX_STORED_CODE_POINTS - codePoints(TRUNCATION_MARKER);
    const head = Math.floor(retained * HEAD_RATIO);
    const tail = retained - head;
    const tailStart = parsedLength - tail;
    return { parsedLength, retained, head, tail, tailStart };
};

const CASES = {
    c1: {
        conversations: () => [truncationConversation(), controlConversation()],
        describe() {
            const { parsedLength, retained, head, tail, tailStart } =
                truncationBoundary();
            const trimmed = longText.trim();
            return [
                `long message      ${BLOCKS * BLOCK_WIDTH} code points generated, ${parsedLength} after the adapter's trim`,
                `marker            ${codePoints(TRUNCATION_MARKER)} code points`,
                `retained budget   ${retained} = head ${head} + tail ${tail}`,
                `head ends with    ${JSON.stringify(trimmed.slice(head - BLOCK_WIDTH, head).trim())}`,
                `tail starts with  ${JSON.stringify(trimmed.slice(tailStart, tailStart + 14))}`,
            ];
        },
    },
    c4: {
        conversations: () => [
            truncationConversation(),
            controlConversation([
                message(
                    "c4-control-msg-3",
                    "human",
                    "C4 fixture: this turn exists only in the newer export.",
                    "2026-08-19T02:00:00.000Z"
                ),
                message(
                    "c4-control-msg-4",
                    "assistant",
                    "Appended so the conversation digest changes while the stable id does not.",
                    "2026-08-19T02:00:01.000Z"
                ),
            ]),
        ],
        describe: () => [
            `${TRUNCATION_UUID}  unchanged -> expect "duplicate", skipped`,
            `${CONTROL_UUID}  +2 messages -> expect a new snapshot in the same lineage`,
            'review step should read "가져올 대화 1개 준비됨 · 중복 1개 제외"',
        ],
    },
};

const caseKey = argument("case");
const chosen = caseKey ? CASES[caseKey] : null;
if (!chosen) {
    fail(
        `--case is required. Known cases:\n${Object.keys(CASES)
            .map((key) => `  ${key}`)
            .join("\n")}`
    );
}

const out = argument("out") ?? `${caseKey}-conversations.json`;
writeFileSync(out, JSON.stringify(chosen.conversations(), null, 2));
console.log(`wrote ${out}`);
for (const line of chosen.describe()) console.log(`  ${line}`);
console.log(
    "  upload it as conversations.json -- the filename is what the wizard sees"
);
