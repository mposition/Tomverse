/**
 * Batch 002 — `durable_facts:en` first batch. **Candidate pool, not dataset.**
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch), §6.5
 * (each cell's first batch is reviewed before the rest is generated).
 *
 * These are AI drafts. Policy docs/policy/external-conversation-import-and-memory.md §12.6 says whatever an agent makes
 * is a candidate pool, and docs/ops/memory-extraction-eval-dataset.md §6.2 says a draft carries no authority
 * — so this file is not imported by `lib/memoryExtractionEvalFixtures.ts`.
 * Adoption moves it into `lib/memoryExtractionEvalAdopted/`.
 *
 * Written to be distinct from the four `durable_facts:en` seed cases, which
 * already cover a backend engineer, short answers, lactose intolerance and a
 * Rust inventory tracker. Repeating those would grow the cell without
 * widening what it measures.
 *
 * Kind spread (docs/ops/memory-extraction-eval-dataset.md §3.2: no kind above 40% of the cell) — widest is 3/25 = 12%:
 *   occupation 3, constraint 3, identity 2, preference 2, expertise 2,
 *   long_term_goal 2, project 2, decision 2, relationship 2,
 *   recurring_context 1, communication_style 1, verbosity 1, language 1,
 *   code_style 1.
 *
 * docs/ops/memory-extraction-eval-dataset.md §3.1 asks for deliberate spread in length, register and topic: there are
 * two-turn exchanges and longer ones, a message with typos, one with an
 * emoji, clipped notes and full paragraphs. Names, places, dates and numbers
 * are invented.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("cand-b002");
    return {
        externalConversationId: id,
        title,
        messages: turns.map(([role, content], index) => ({
            externalMessageId: `${id}-m${index + 1}`,
            role,
            content,
        })),
    };
};

const durableEn = (
    index: number,
    kind: string,
    mustInclude: readonly string[],
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCase => ({
    id: `cand-durable-en-${index}`,
    category: "durable_facts",
    language: "en",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_002_DURABLE_EN: readonly MemoryEvalCase[] = [
    durableEn(1, "occupation", ["paramedic"], "Shift work", [
        ["user", "I'm a paramedic, twelve-hour shifts, mostly nights this quarter. Any advice on eating properly when the schedule is like that?"],
        ["assistant", "Batch cooking on your days off tends to survive that schedule better than daily prep."],
        ["user", "That's roughly what I've been doing."],
    ]),
    durableEn(2, "occupation", ["chemistry", "teacher"], "Eleven years in", [
        ["user", "I've been a high school chemistry teacher for eleven years."],
        ["assistant", "That's a long stretch in one subject. What's the question?"],
        ["user", "How to make titration feel less like a recipe to follow."],
    ]),
    durableEn(3, "occupation", ["bakery"], "Small business", [
        ["user", "I run a small bakery. Two staff, one oven, no room for a third."],
        ["assistant", "Understood — small operation, tight constraints."],
    ]),
    durableEn(4, "identity", ["lisbon"], "Where I am", [
        ["user", "I'm based in Lisbon, if that changes any of your suggestions."],
        ["assistant", "It does for anything time-zone or supplier related. Noted."],
    ]),
    durableEn(5, "identity", ["1974"], "Age", [
        ["user", "I was born in 1974, for whatever that's worth here."],
        ["assistant", "Noted."],
    ]),
    durableEn(6, "preference", ["examples", "theory"], "How I learn", [
        ["user", "I'd much rather see examples first and the theory afterwards. The other order never sticks for me."],
        ["assistant", "Then I'll lead with examples from here on."],
    ]),
    durableEn(7, "preference", ["aisle"], "Flights", [
        ["user", "I always take the aisle seat, every flight, no exceptions."],
        ["assistant", "Got it — aisle when I'm suggesting bookings."],
    ]),
    durableEn(8, "constraint", ["subscription"], "No recurring costs", [
        ["user", "Please don't suggest anything that needs a subscription. I only buy things outright."],
        ["assistant", "One-off purchases and free tools only, then."],
        ["user", "Right."],
    ]),
    durableEn(9, "constraint", ["budget", "2000"], "Hard ceiling", [
        ["user", "my budget is 2000 dollars and thats a hard limit, i cant go over it even a little"],
        ["assistant", "I'll keep every option under that."],
    ]),
    durableEn(10, "constraint", ["penicillin"], "Medication", [
        ["user", "I'm allergic to penicillin — worth knowing before you mention any antibiotic."],
        ["assistant", "I'll flag that, though a prescriber makes the call."],
    ]),
    durableEn(11, "expertise", ["tax law"], "Skip the basics", [
        ["user", "I've practised tax law for fifteen years. You can skip the introductions and go straight to the edge cases."],
        ["assistant", "Straight to the edge cases, then."],
    ]),
    durableEn(12, "expertise", ["beginner", "spreadsheets"], "Starting out", [
        ["user", "I'm a complete beginner with spreadsheets. I know what a cell is and that's about the extent of it."],
        ["assistant", "We'll start from there, no assumptions."],
        ["user", "Please do 🙏"],
    ]),
    durableEn(13, "long_term_goal", ["marathon"], "Distance", [
        ["user", "The goal is a marathon. Not this year, but that's what everything is building toward."],
        ["assistant", "A multi-year build changes how the early training should look."],
    ]),
    durableEn(14, "long_term_goal", ["retire", "55"], "Timeline", [
        ["user", "I want to retire at 55. That number has been fixed for a while now."],
        ["assistant", "Fixed target, then — that shapes the savings rate."],
    ]),
    durableEn(15, "project", ["camper", "van"], "Weekend build", [
        ["user", "I'm restoring a 1968 camper van. Been at it two winters now and the electrics are still beating me."],
        ["assistant", "Old vehicle electrics usually mean tracing rather than replacing."],
        ["user", "That's the part I keep putting off."],
    ]),
    durableEn(16, "project", ["cookbook"], "Family recipes", [
        ["user", "I'm putting together a cookbook of my grandmother's recipes. Most of them are on index cards in her handwriting."],
        ["assistant", "Transcription order matters more than layout at this stage."],
    ]),
    durableEn(17, "decision", ["kubernetes"], "Settled", [
        ["user", "We've decided on kubernetes. That's settled and I don't want to reopen it."],
        ["assistant", "Then I'll answer inside that choice rather than around it."],
    ]),
    durableEn(18, "decision", ["homeschool"], "Schooling", [
        ["user", "After a lot of back and forth we decided to homeschool our daughter starting this autumn."],
        ["assistant", "That changes what kind of resources are useful."],
        ["user", "It does, and the decision itself is final."],
    ]),
    durableEn(19, "relationship", ["partner", "deaf"], "Household", [
        ["user", "My partner is deaf, so anything you suggest that's audio-only won't work for us."],
        ["assistant", "I'll keep suggestions to things with captions or text."],
    ]),
    durableEn(20, "relationship", ["father", "dementia"], "Care", [
        ["user", "I look after my father. He has dementia and lives with us now, which reshapes most of the week."],
        ["assistant", "That's a large constraint on scheduling anything."],
        ["user", "It is. I mention it so you don't suggest things that assume free evenings."],
    ]),
    durableEn(21, "recurring_context", ["friday"], "Standing block", [
        ["user", "Every Friday afternoon I'm offline for prayers, so don't plan anything for that window."],
        ["assistant", "Friday afternoons are out."],
    ]),
    durableEn(22, "communication_style", ["hedge"], "Plain answers", [
        ["user", "Don't hedge with me. If you're not sure, say you're not sure and say why."],
        ["assistant", "Understood — I'll state uncertainty rather than soften it."],
    ]),
    durableEn(23, "verbosity", ["detail"], "Longer, please", [
        ["user", "Give me the long version. I actually want the detail, not the summary."],
        ["assistant", "Then I'll expand rather than compress."],
    ]),
    durableEn(24, "language", ["spanish"], "Reply language", [
        ["user", "Write your answers in spanish even when I ask in English. I read it faster than I write it."],
        ["assistant", "Entendido — I'll answer in Spanish."],
    ]),
    durableEn(25, "code_style", ["type hints"], "Python examples", [
        ["user", "Every python example you give me should have type hints. I've been bitten too many times without them."],
        ["assistant", "Type hints on everything, then."],
    ]),
];
