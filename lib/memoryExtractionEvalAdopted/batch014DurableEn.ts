/**
 * Batch 014 — `durable_facts:en`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-014-durable-facts-en.md`:
 * all 10 sampled cases 채택 under docs/ops/memory-extraction-eval-dataset.md §6.3's 20% sample review,
 * draft disagreement 0%, diversity judged sufficient, the drafting setup
 * recorded as unchanged, and the explicit batch adoption line filled.
 *
 * The other 36 cases enter the dataset on that adoption line rather than on a
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
 * 46 cases, inside the 25-50 range of docs/ops/memory-extraction-eval-dataset.md §6.1. The
 * number is 46 rather than 50 because the cell is 71 short of its floor: 46
 * now and 25 in the last batch lands on 200 exactly, and neither batch falls
 * under the range's floor. Drafting past 200 would buy nothing and would cost
 * a reviewer verdicts on cases the floor does not ask for.
 *
 * **Written against the 129 cases the cell already holds.** No `mustInclude`
 * topic repeats — a second case on the same topic grows the count without
 * widening what the cell measures (docs/ops/memory-extraction-eval-dataset.md §3.2).
 *
 * Kind spread — widest is 5/46 = 11%, well under the 40% ceiling:
 *   constraint 5, identity 4, preference 4, occupation 4, expertise 4,
 *   long_term_goal 3, project 3, decision 3, relationship 3,
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
    const id = nextId("cand-b014");
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
    id: `cand-durable-en4-${index}`,
    category: "durable_facts",
    language: "en",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_014_DURABLE_EN: readonly MemoryEvalCase[] = [
    durableEn(1, "constraint", ["gluten"], "What I can eat", [
        ["user", "I'm coeliac, so gluten is completely off the table for me."],
        ["assistant", "I'll keep everything gluten free."],
    ]),
    durableEn(2, "constraint", ["fragrance"], "Sensitivity", [
        ["user", "I react badly to fragrance, so scented products are out."],
        ["assistant", "I'll stick to unscented options."],
    ]),
    durableEn(3, "constraint", ["drive"], "Getting about", [
        ["user", "I can't drive — never learned — so anything that assumes a car won't work."],
        ["assistant", "I'll plan around public transport."],
    ]),
    durableEn(4, "constraint", ["weekends"], "When I'm free", [
        ["user", "Weekends are completely spoken for. Nothing can go there."],
        ["assistant", "I'll keep suggestions to weekdays."],
    ]),
    durableEn(5, "constraint", ["printer"], "Equipment", [
        ["user", "There's no printer here, so please don't suggest anything that needs printing out."],
        ["assistant", "I'll keep it all on screen."],
    ]),
    durableEn(6, "identity", ["cardiff"], "Where I am", [
        ["user", "I'm in Cardiff and have been for most of my adult life."],
        ["assistant", "I'll keep things local to there."],
    ]),
    durableEn(7, "identity", ["1962"], "Age", [
        ["user", "Born in 1962, so retirement questions are live ones for me."],
        ["assistant", "I'll answer with that in mind."],
    ]),
    durableEn(8, "identity", ["hard of hearing"], "Hearing", [
        ["user", "I'm hard of hearing in one ear. Phone calls are difficult."],
        ["assistant", "I'll favour written options."],
    ]),
    durableEn(9, "identity", ["dual citizenship"], "Nationality", [
        ["user", "I have dual citizenship, so paperwork usually means checking two sets of rules."],
        ["assistant", "I'll cover both where it matters."],
    ]),
    durableEn(10, "preference", ["newspaper"], "News", [
        ["user", "I read a printed newspaper. I don't use news apps at all."],
        ["assistant", "I'll bear that in mind."],
    ]),
    durableEn(11, "preference", ["subtitles"], "Video", [
        ["user", "I watch everything with subtitles on, even in my own language."],
        ["assistant", "I'll check for subtitled versions."],
    ]),
    durableEn(12, "preference", ["eating alone"], "Meals", [
        ["user", "I actually prefer eating alone. Group meals are something I avoid."],
        ["assistant", "I'll suggest places that suit that."],
    ]),
    durableEn(13, "preference", ["cash"], "Paying", [
        ["user", "I pay in cash wherever I can. Card-only places annoy me."],
        ["assistant", "I'll note that when it's relevant."],
    ]),
    durableEn(14, "occupation", ["hygienist"], "My job", [
        ["user", "I'm a dental hygienist. We run Saturday clinics too."],
        ["assistant", "I'll assume that pattern."],
    ]),
    durableEn(15, "occupation", ["orchard"], "Work", [
        ["user", "I run an apple orchard. During harvest I'm unavailable for anything else."],
        ["assistant", "I'll plan around the season."],
    ]),
    durableEn(16, "occupation", ["school cook"], "Where I work", [
        ["user", "I'm a school cook, so my day ends early but starts at six."],
        ["assistant", "I'll use those hours."],
    ]),
    durableEn(17, "occupation", ["decorator"], "Trade", [
        ["user", "I'm a decorator. Different site every week, no fixed office."],
        ["assistant", "I'll frame things around site work."],
    ]),
    durableEn(18, "expertise", ["calligraphy"], "Long practice", [
        ["user", "I've done calligraphy for twenty years — you can use the proper script names."],
        ["assistant", "I'll use them directly."],
    ]),
    durableEn(19, "expertise", ["engines"], "Comfortable with", [
        ["user", "Engines are my trade. You don't need to explain what a manifold is."],
        ["assistant", "I'll skip that level of detail."],
    ]),
    durableEn(20, "expertise", ["portuguese", "beginner"], "New language", [
        ["user", "I'm a complete beginner in Portuguese. I don't know the pronunciation rules yet."],
        ["assistant", "I'll start from the basics."],
    ]),
    durableEn(21, "expertise", ["lifeguard"], "Qualified in", [
        ["user", "I'm a qualified lifeguard, so water safety terminology is fine as-is."],
        ["assistant", "I'll use the standard terms."],
    ]),
    durableEn(22, "long_term_goal", ["poetry"], "Someday", [
        ["user", "Publishing a poetry collection is the long-term aim. Still gathering the poems."],
        ["assistant", "I'll treat that as the goal."],
    ]),
    durableEn(23, "long_term_goal", ["abroad"], "Where I'm heading", [
        ["user", "The plan is to move abroad eventually. Everything I'm doing points that way."],
        ["assistant", "I'll keep that destination in view."],
    ]),
    durableEn(24, "long_term_goal", ["social work"], "Career change", [
        ["user", "I want to retrain into social work. I'm looking at evening courses now."],
        ["assistant", "I'll frame options around retraining."],
    ]),
    durableEn(25, "project", ["footpaths"], "Mapping", [
        ["user", "I'm mapping the local footpaths, walking and recording them one by one."],
        ["assistant", "I'll treat that as the running project."],
    ]),
    durableEn(26, "project", ["album"], "Recording", [
        ["user", "My band is recording an album. Five tracks done so far."],
        ["assistant", "I'll assume that's the project you mean."],
    ]),
    durableEn(27, "project", ["barn"], "Conversion", [
        ["user", "I'm converting an old barn. It's a weekends-only job and it'll take years."],
        ["assistant", "I'll size things to weekend work."],
    ]),
    durableEn(28, "decision", ["television"], "Household", [
        ["user", "We got rid of the television and we're not getting another one."],
        ["assistant", "I'll leave that out of suggestions."],
    ]),
    durableEn(29, "decision", ["mortgage"], "Money", [
        ["user", "We decided to overpay the mortgage rather than invest. That's settled."],
        ["assistant", "I'll work from that decision."],
    ]),
    durableEn(30, "decision", ["side business"], "Winding down", [
        ["user", "I wound down the side business deliberately. I'm not restarting it."],
        ["assistant", "I won't raise it again."],
    ]),
    durableEn(31, "relationship", ["mother", "care home"], "Family", [
        ["user", "My mother is in a care home and I visit twice a week."],
        ["assistant", "I'll account for those visits."],
    ]),
    durableEn(32, "relationship", ["daughter", "university"], "Children", [
        ["user", "My daughter is at university, so the house is quieter than it used to be."],
        ["assistant", "Noted."],
    ]),
    durableEn(33, "relationship", ["father-in-law"], "Who I live with", [
        ["user", "My father-in-law lives with us, and household decisions go through him too."],
        ["assistant", "I'll treat those as joint decisions."],
    ]),
    durableEn(34, "recurring_context", ["appraisal"], "Yearly", [
        ["user", "Every October is appraisal season and it swallows the whole month."],
        ["assistant", "I'll avoid loading anything into October."],
    ]),
    durableEn(35, "recurring_context", ["saturday"], "Weekly", [
        ["user", "Saturday mornings are football, every week, no exceptions."],
        ["assistant", "I'll keep Saturday mornings clear."],
    ]),
    durableEn(36, "recurring_context", ["peak season"], "Seasonal", [
        ["user", "Summer is peak season for us, so those three months I barely get a day off."],
        ["assistant", "I'll assume no spare capacity then."],
    ]),
    durableEn(37, "communication_style", ["don't know"], "Uncertainty", [
        ["user", "If you're not sure, say you don't know. A made-up answer is worse than none."],
        ["assistant", "I'll say so when I'm unsure."],
    ]),
    durableEn(38, "communication_style", ["jargon"], "Terminology", [
        ["user", "Keep the jargon but put a short gloss in brackets. I need to learn the words themselves."],
        ["assistant", "I'll keep the terms and gloss them."],
    ]),
    durableEn(39, "tone", ["jokes"], "Register", [
        ["user", "No jokes, please. Straight answers only."],
        ["assistant", "I'll keep it plain."],
    ]),
    durableEn(40, "verbosity", ["one paragraph"], "Length", [
        ["user", "One paragraph per answer. I'll ask if I want more."],
        ["assistant", "I'll hold to that."],
    ]),
    durableEn(41, "structure", ["numbered steps"], "Layout", [
        ["user", "Anything procedural should come as numbered steps, not prose."],
        ["assistant", "I'll number the steps."],
    ]),
    durableEn(42, "formatting", ["emoji"], "Presentation", [
        ["user", "Please don't use emoji. I paste a lot of this into work documents."],
        ["assistant", "I'll leave them out."],
    ]),
    durableEn(43, "language", ["italian"], "Reply language", [
        ["user", "Answer in Italian from now on — I'm trying to build the habit."],
        ["assistant", "Risponderò in italiano d'ora in poi."],
    ]),
    durableEn(44, "explanation_depth", ["twelve"], "Level", [
        ["user", "Explain things as you would to a twelve year old. I have no background in this."],
        ["assistant", "I'll keep it simple."],
    ]),
    durableEn(45, "citation_preference", ["publication"], "Sources", [
        ["user", "When you cite something, give me the publication year. Old material is a problem here."],
        ["assistant", "I'll include the year."],
    ]),
    durableEn(46, "code_style", ["single file"], "Code examples", [
        ["user", "Give code examples as a single file rather than split across modules. Easier to paste."],
        ["assistant", "I'll keep each example in one file."],
    ]),
];
