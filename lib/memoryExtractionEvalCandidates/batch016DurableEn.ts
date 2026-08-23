/**
 * Batch 016 — `durable_facts:en`, fifth and final batch. **Candidate pool.**
 *
 * 25 cases, the bottom of docs/ops/memory-extraction-eval-dataset.md §6.1's 25-50 range. That
 * is the exact remainder: 29 adopted plus batches 010, 012, 014 and this one
 * is 200, the floor docs/policy/external-conversation-import-and-memory.md §12.2 sets for this arm. Nothing
 * beyond it is drafted, because a case past the floor still costs a reviewer
 * a verdict and buys no coverage the floor asked for.
 *
 * These are AI drafts. Policy docs/policy/external-conversation-import-and-memory.md §12.6 keeps them a candidate pool
 * until a person adopts them, and this file is deliberately not imported by
 * `lib/memoryExtractionEvalFixtures.ts`.
 *
 * **Written against the 175 cases the cell already holds.** No `mustInclude`
 * topic repeats (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * Kind spread — widest is 3/25 = 12%:
 *   constraint 3, and 2 each of identity, preference, occupation, expertise,
 *   long_term_goal, project, decision, relationship, recurring_context, then
 *   one each of communication_style, verbosity, formatting,
 *   citation_preference.
 *
 * Names, places, ages and numbers are invented.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("cand-b016");
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
    id: `cand-durable-en5-${index}`,
    category: "durable_facts",
    language: "en",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_016_DURABLE_EN: readonly MemoryEvalCase[] = [
    durableEn(1, "constraint", ["dizzy"], "Standing", [
        ["user", "I get dizzy if I stand for long, so anything that needs me on my feet is out."],
        ["assistant", "I'll suggest seated options."],
    ]),
    durableEn(2, "constraint", ["stairs"], "Access", [
        ["user", "I can't manage stairs. Ground floor or a lift, always."],
        ["assistant", "I'll check step-free access."],
    ]),
    durableEn(3, "constraint", ["laptop"], "Hardware", [
        ["user", "My laptop is ten years old. Anything heavy simply won't run on it."],
        ["assistant", "I'll stick to lightweight tools."],
    ]),
    durableEn(4, "identity", ["belfast"], "Where I live", [
        ["user", "I'm in Belfast, and have been for twenty years."],
        ["assistant", "I'll keep it local to there."],
    ]),
    durableEn(5, "identity", ["2001"], "Age", [
        ["user", "I was born in 2001 — I've only just started working."],
        ["assistant", "I'll answer at that stage."],
    ]),
    durableEn(6, "preference", ["handwritten"], "Notes", [
        ["user", "My notes are handwritten. Typing them out doesn't stick for me."],
        ["assistant", "I'll shape things so they're easy to copy by hand."],
    ]),
    durableEn(7, "preference", ["markets"], "Shopping", [
        ["user", "I shop at markets rather than supermarkets whenever I can."],
        ["assistant", "I'll bear that in mind for ingredients."],
    ]),
    durableEn(8, "occupation", ["cabin crew"], "My job", [
        ["user", "I'm cabin crew, so I'm away about ten days a month."],
        ["assistant", "I'll plan around that."],
    ]),
    durableEn(9, "occupation", ["fisherman"], "Work", [
        ["user", "I'm a fisherman. The weather rewrites my week most weeks."],
        ["assistant", "I won't assume a fixed schedule."],
    ]),
    durableEn(10, "expertise", ["chess"], "Long practice", [
        ["user", "I've played chess seriously for years — no need to explain openings to me."],
        ["assistant", "I'll use the names directly."],
    ]),
    durableEn(11, "expertise", ["masonry"], "Trade knowledge", [
        ["user", "Stone masonry is my trade, so the terminology is fine as-is."],
        ["assistant", "I'll keep the terms."],
    ]),
    durableEn(12, "long_term_goal", ["hostel"], "Someday", [
        ["user", "Opening a walkers' hostel is the long-term plan. I'm still looking for the building."],
        ["assistant", "I'll treat that as the goal."],
    ]),
    durableEn(13, "long_term_goal", ["woodwork"], "Second act", [
        ["user", "I want to turn woodwork into an actual business eventually."],
        ["assistant", "I'll frame things around that."],
    ]),
    durableEn(14, "project", ["comic"], "Ongoing", [
        ["user", "I draw a comic, one page a fortnight. It's just me doing all of it."],
        ["assistant", "I'll treat that as the running project."],
    ]),
    durableEn(15, "project", ["conference"], "Coming up", [
        ["user", "I'm preparing a conference talk for the autumn. Abstract is in, slides aren't."],
        ["assistant", "I'll work to that deadline."],
    ]),
    durableEn(16, "decision", ["gym"], "Cancelled", [
        ["user", "I cancelled the gym membership and I'm training at home instead. That's decided."],
        ["assistant", "I'll suggest home options only."],
    ]),
    durableEn(17, "decision", ["city"], "Where we're staying", [
        ["user", "We decided against moving to the city. That question is closed."],
        ["assistant", "I'll assume you're staying put."],
    ]),
    durableEn(18, "relationship", ["grandson"], "Family", [
        ["user", "I look after my grandson three days a week."],
        ["assistant", "I'll account for those days."],
    ]),
    durableEn(19, "relationship", ["brother-in-law"], "Business", [
        ["user", "I run the shop with my brother-in-law, so money decisions are always joint."],
        ["assistant", "I'll treat them as joint calls."],
    ]),
    durableEn(20, "recurring_context", ["march"], "Yearly", [
        ["user", "Every March I have my annual check-ups. That week is full of appointments."],
        ["assistant", "I'll keep March clear."],
    ]),
    durableEn(21, "recurring_context", ["thursday"], "Weekly", [
        ["user", "Thursdays are a late finish for me, every week."],
        ["assistant", "I'll leave Thursday evenings out."],
    ]),
    durableEn(22, "communication_style", ["example"], "Order of explanation", [
        ["user", "Show me an example before the explanation. I don't follow abstract descriptions."],
        ["assistant", "I'll lead with an example."],
    ]),
    durableEn(23, "verbosity", ["five lines"], "Length", [
        ["user", "About five lines is right for me. Longer than that and I stop reading."],
        ["assistant", "I'll aim for that."],
    ]),
    durableEn(24, "formatting", ["code block"], "Commands", [
        ["user", "Put commands in a code block. Copying them out of prose goes wrong."],
        ["assistant", "I'll fence them."],
    ]),
    durableEn(25, "citation_preference", ["links"], "Where sources go", [
        ["user", "Keep links out of the body and gather them at the end. They break my reading."],
        ["assistant", "I'll list them at the bottom."],
    ]),
];
