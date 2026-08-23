/**
 * Batch 010 — `durable_facts:en`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-010-durable-facts-en.md`:
 * all 10 sampled cases 채택 under docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample review,
 * draft disagreement 0%, diversity judged sufficient, the drafting setup
 * recorded as unchanged, and the explicit batch adoption line filled.
 *
 * The other 40 cases enter the dataset on that adoption line rather than on a
 * verdict of their own. docs/ops/memory-extraction-eval-dataset.md §6.3 is explicit that this is what the line is for:
 * seeing the sample and saying nothing is not adoption.
 *
 * The `cand-` ids are kept: they are what the review record names, and a case
 * that cannot be traced back to the verdict that admitted it is a case whose
 * review cannot be checked (docs/ops/memory-extraction-eval-dataset.md §7.1 asks for the judgement basis on record).
 *
 * `tests/memoryEvalAdoptedBatches.test.mjs` re-reads that record on every run:
 * if the adoption line ever stops saying 채택, these cases stop being allowed
 * in the dataset.
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch). 50 here,
 * the top of that range: the cell's first batch has been reviewed
 * (docs/ops/memory-extraction-eval-dataset.md §6.5), so
 * what is left is volume, and 50 halves the number of review sheets without
 * changing how many verdicts docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample asks for.
 *
 * **Written against what the cell already holds.** The adopted cases cover
 * paramedic, chemistry teacher, bakery, Lisbon, 1974, examples-over-theory,
 * aisle seat, subscriptions, budget 2000, penicillin, tax law, spreadsheets,
 * marathon, retire at 55, camper van, cookbook, kubernetes, homeschooling, a
 * deaf partner, a father with dementia, Friday, hedging, detail, Spanish and
 * Python type hints. None of them appears again — a second case on the same
 * topic grows the count without widening what the cell measures
 * (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * It also reaches the five kinds the first batch never used — `tone`,
 * `structure`, `formatting`, `explanation_depth`, `citation_preference`. A
 * cell that exercises ten of the nineteen kinds reports the quality of ten.
 *
 * Kind spread (docs/ops/memory-extraction-eval-dataset.md §3.2: no kind above 40% of the cell) — widest is 5/50 = 10%:
 *   constraint 5, identity 4, preference 4, occupation 4, expertise 4,
 *   long_term_goal 4, project 4, decision 4, relationship 4,
 *   recurring_context 3, communication_style 2, and one each of tone,
 *   verbosity, structure, formatting, language, explanation_depth,
 *   citation_preference, code_style.
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
    const id = nextId("cand-b010");
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
    id: `cand-durable-en2-${index}`,
    category: "durable_facts",
    language: "en",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_010_DURABLE_EN: readonly MemoryEvalCase[] = [
    durableEn(1, "identity", ["halifax"], "Where I live", [
        ["user", "I've lived in Halifax my whole life and I'm not moving."],
        ["assistant", "I'll keep suggestions local to there."],
    ]),
    durableEn(2, "identity", ["1988"], "Age", [
        ["user", "Born in 1988, if that matters for any of the age-banded stuff."],
        ["assistant", "Noted — I'll use that band."],
    ]),
    durableEn(3, "identity", ["twin"], "Sibling", [
        ["user", "I have an identical twin, which comes up more often than you'd think."],
        ["assistant", "Good to know."],
    ]),
    durableEn(4, "identity", ["colour", "blind"], "Colour vision", [
        ["user", "I'm red-green colour blind, so don't tell me to look for the red line on a chart."],
        ["assistant", "I'll describe chart series by label and position instead."],
    ]),
    durableEn(5, "preference", ["night"], "When I work", [
        ["user", "I do all my real work at night. Mornings are a write-off for me."],
        ["assistant", "I'll plan schedules around a late start."],
    ]),
    durableEn(6, "preference", ["train"], "Travel", [
        ["user", "For anything under six hours I'd rather take the train than fly."],
        ["assistant", "I'll price rail first on those routes."],
    ]),
    durableEn(7, "preference", ["secondhand"], "Buying things", [
        ["user", "I buy almost everything secondhand. It's a habit at this point, not a budget thing."],
        ["assistant", "I'll look at used listings first."],
    ]),
    durableEn(8, "preference", ["paper"], "Reading", [
        ["user", "I read on paper. E-books just don't stick for me 📚"],
        ["assistant", "I'll point you at print editions where they exist."],
    ]),
    durableEn(9, "occupation", ["midwife"], "My job", [
        ["user", "I'm a midwife. Twelve-hour shifts, mostly nights."],
        ["assistant", "I'll assume that schedule."],
    ]),
    durableEn(10, "occupation", ["archivist"], "Day to day", [
        ["user", "I work as an archivist at a county records office."],
        ["assistant", "I'll keep that context in mind."],
    ]),
    durableEn(11, "occupation", ["electrician"], "Trade", [
        ["user", "I'm a self-employed electrician, so my invoicing questions are about my own books."],
        ["assistant", "Understood — sole trader, then."],
    ]),
    durableEn(12, "occupation", ["translator"], "Freelance", [
        ["user", "I'm a freelance translator working on legal documents, about six clients."],
        ["assistant", "I'll frame things around freelance work."],
    ]),
    durableEn(13, "expertise", ["statistics"], "Skip ahead", [
        ["user", "I have a graduate background in statistics, so please don't explain what a p-value is."],
        ["assistant", "I'll skip the fundamentals."],
    ]),
    durableEn(14, "expertise", ["sailing"], "Comfortable there", [
        ["user", "I've been sailing since I was a kid. Points of sail, rigging, all of that is second nature."],
        ["assistant", "I'll use the terms without defining them."],
    ]),
    durableEn(15, "expertise", ["new", "gardening"], "Starting out", [
        ["user", "I'm completely new to gardening. I don't know what hardening off means."],
        ["assistant", "I'll define terms as they come up."],
    ]),
    durableEn(16, "expertise", ["accessibility"], "My field", [
        ["user", "Accessibility auditing is what I do professionally, so WCAG references are fine as-is."],
        ["assistant", "I'll cite the criteria directly."],
    ]),
    durableEn(17, "long_term_goal", ["sabbatical"], "Someday", [
        ["user", "The long-term plan is a year-long sabbatical to write. No date yet, but it's the direction."],
        ["assistant", "I'll treat that as the goal."],
    ]),
    durableEn(18, "long_term_goal", ["citizenship"], "Paperwork ahead", [
        ["user", "I'm working toward citizenship here. It's a multi-year thing and it shapes a lot of my decisions."],
        ["assistant", "I'll factor that in."],
    ]),
    durableEn(19, "long_term_goal", ["debt"], "Financial aim", [
        ["user", "Everything I'm doing financially is aimed at being debt free. That's the goal, not returns."],
        ["assistant", "I'll optimise for payoff rather than yield."],
    ]),
    durableEn(20, "long_term_goal", ["teach"], "Second career", [
        ["user", "Eventually I want to teach at a community college. That's the endpoint I'm building toward."],
        ["assistant", "I'll keep that destination in view."],
    ]),
    durableEn(21, "project", ["greenhouse"], "In the garden", [
        ["user", "I'm building a greenhouse in the back garden. It'll take me most of the summer."],
        ["assistant", "I'll assume that's the project when you mention the build."],
    ]),
    durableEn(22, "project", ["podcast"], "Side thing", [
        ["user", "I run a small podcast about local history. Two episodes a month."],
        ["assistant", "Got it — that's the ongoing project."],
    ]),
    durableEn(23, "project", ["thesis"], "Academic", [
        ["user", "My thesis is on coastal erosion. I'm in the writing-up stage."],
        ["assistant", "I'll assume writing-up unless you say otherwise."],
    ]),
    durableEn(24, "project", ["bike"], "Restoration", [
        ["user", "I'm restoring a 1970s motorbike in the garage. It's a long slow one."],
        ["assistant", "Noted as the standing project."],
    ]),
    durableEn(25, "decision", ["postgres"], "Settled question", [
        ["user", "We settled on Postgres for the new service. That part is not up for discussion again."],
        ["assistant", "I'll take that as fixed."],
    ]),
    durableEn(26, "decision", ["renting"], "Housing", [
        ["user", "We decided to keep renting rather than buy. It's a deliberate choice, not a temporary one."],
        ["assistant", "I'll stop framing options around ownership."],
    ]),
    durableEn(27, "decision", ["car"], "Getting around", [
        ["user", "We got rid of the car last year and decided not to replace it."],
        ["assistant", "I'll assume no car when suggesting routes."],
    ]),
    durableEn(28, "decision", ["one", "supplier"], "Sourcing", [
        ["user", "After the last mess we decided to consolidate to one supplier. That call is made."],
        ["assistant", "I'll treat multi-sourcing as off the table."],
    ]),
    durableEn(29, "relationship", ["daughter", "coeliac"], "Cooking for the house", [
        ["user", "My daughter is coeliac, so anything I cook at home has to be gluten free."],
        ["assistant", "I'll keep household recipes gluten free."],
    ]),
    durableEn(30, "relationship", ["mother", "japan"], "Family abroad", [
        ["user", "My mother lives in Japan and I visit twice a year."],
        ["assistant", "I'll bear the time difference in mind."],
    ]),
    durableEn(31, "relationship", ["co-founder"], "Who I work with", [
        ["user", "I have a co-founder, and any decision about equity or hiring goes through both of us."],
        ["assistant", "I'll frame those as joint decisions."],
    ]),
    durableEn(32, "relationship", ["flatmates"], "Living situation", [
        ["user", "I live with three flatmates, so anything involving space or noise is constrained."],
        ["assistant", "I'll account for shared space."],
    ]),
    durableEn(33, "constraint", ["dial-up"], "Connection", [
        ["user", "My internet at home is barely faster than dial-up, so don't suggest anything that streams."],
        ["assistant", "I'll stick to low-bandwidth options."],
    ]),
    durableEn(34, "constraint", ["shellfish"], "Allergy", [
        ["user", "Severe shellfish allergy here. Please never include it in a recipe suggestion."],
        ["assistant", "I'll exclude shellfish entirely."],
    ]),
    durableEn(35, "constraint", ["windows"], "What I run", [
        ["user", "I'm on Windows only. No Mac, no Linux box, so shell instructions need to work there."],
        ["assistant", "I'll give Windows-native steps."],
    ]),
    durableEn(36, "constraint", ["30", "minutes"], "Time available", [
        ["user", "I have about 30 minutes a day for this and no more. Plans that assume two hours are useless to me."],
        ["assistant", "I'll size everything to that."],
    ]),
    durableEn(37, "constraint", ["phone", "calls"], "Contact method", [
        ["user", "I can't take phone calls at work, so anything requiring a call has to wait until evening."],
        ["assistant", "I'll prefer written channels."],
    ]),
    durableEn(38, "recurring_context", ["monday"], "Standing commitment", [
        ["user", "Every Monday morning I'm in a two-hour review that I can't move."],
        ["assistant", "I'll keep Monday mornings clear."],
    ]),
    durableEn(39, "recurring_context", ["quarter"], "Cycle", [
        ["user", "We close the books at the end of each quarter and that week is always chaos."],
        ["assistant", "I'll avoid scheduling anything into those weeks."],
    ]),
    durableEn(40, "recurring_context", ["school", "run"], "Daily fixture", [
        ["user", "I do the school run at half three every weekday, so afternoons are broken up."],
        ["assistant", "I'll treat mid-afternoon as unavailable."],
    ]),
    durableEn(41, "communication_style", ["disclaimers"], "How to answer", [
        ["user", "Please drop the disclaimers. Just tell me what you think and I'll decide what to do with it."],
        ["assistant", "I'll answer directly."],
    ]),
    durableEn(42, "communication_style", ["question"], "Check first", [
        ["user", "If my question is ambiguous, ask me one clarifying question before answering. Don't guess."],
        ["assistant", "I'll ask rather than assume."],
    ]),
    durableEn(43, "tone", ["formal"], "Register", [
        ["user", "Keep it formal, please. I often paste your answers straight into work email."],
        ["assistant", "I'll write in a formal register."],
    ]),
    durableEn(44, "verbosity", ["short"], "Length", [
        ["user", "Short answers. A paragraph at most unless I ask you to expand."],
        ["assistant", "I'll keep replies brief."],
    ]),
    durableEn(45, "structure", ["conclusion", "first"], "Order", [
        ["user", "Give me the conclusion first and the reasoning after it. I often only read the first line."],
        ["assistant", "I'll lead with the answer."],
    ]),
    durableEn(46, "formatting", ["tables"], "Layout", [
        ["user", "Use tables when you're comparing things. Prose comparisons are hard for me to follow."],
        ["assistant", "I'll put comparisons in a table."],
    ]),
    durableEn(47, "language", ["german"], "Reply language", [
        ["user", "Answer me in German even when I write in English. I'm trying to keep it up."],
        ["assistant", "Ich antworte ab jetzt auf Deutsch."],
    ]),
    durableEn(48, "explanation_depth", ["trade-offs"], "How deep", [
        ["user", "Don't just give me the recommendation — walk me through the trade-offs behind it."],
        ["assistant", "I'll lay out the alternatives too."],
    ]),
    durableEn(49, "citation_preference", ["primary", "sources"], "Evidence", [
        ["user", "When you cite something, point me at primary sources rather than summaries."],
        ["assistant", "I'll link the original where I can."],
    ]),
    durableEn(50, "code_style", ["test"], "Code examples", [
        ["user", "Any code example you give me should come with a test. That's how I read code."],
        ["assistant", "I'll include a test alongside each example."],
    ]),
];
