/**
 * Batch 012 — `durable_facts:en`, third batch. **Candidate pool, not dataset.**
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch). 50 here,
 * the top of that range, for the same reason batch-010 took it: the cell's
 * brief was settled by its first review, so what is left is volume.
 *
 * These are AI drafts. Policy docs/policy/external-conversation-import-and-memory.md §12.6 keeps them a candidate pool
 * until a person adopts them, and this file is deliberately not imported by
 * `lib/memoryExtractionEvalFixtures.ts`.
 *
 * **Written against the 79 cases the cell already holds** — 29 adopted and the
 * 50 of batch-010. No `mustInclude` topic from either appears again; a second
 * case on the same topic grows the count without widening what the cell
 * measures (docs/ops/memory-extraction-eval-dataset.md §3.2).
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
    const id = nextId("cand-b012");
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
    id: `cand-durable-en3-${index}`,
    category: "durable_facts",
    language: "en",
    expected: [{ id: "e1", kind, mustInclude }],
    conversations: [conversation(title, turns)],
});

export const BATCH_012_DURABLE_EN: readonly MemoryEvalCase[] = [
    durableEn(1, "identity", ["glasgow"], "Where I'm based", [
        ["user", "I'm in Glasgow and I've no plans to leave."],
        ["assistant", "I'll keep things local to there."],
    ]),
    durableEn(2, "identity", ["1995"], "Age", [
        ["user", "I was born in 1995 if any of this is age dependent."],
        ["assistant", "Noted."],
    ]),
    durableEn(3, "identity", ["left-handed"], "Handedness", [
        ["user", "I'm left-handed, which matters more than people think when you're recommending tools."],
        ["assistant", "I'll flag left-handed versions where they exist."],
    ]),
    durableEn(4, "identity", ["only child"], "Family", [
        ["user", "I'm an only child, so anything about siblings doesn't apply to me."],
        ["assistant", "Understood."],
    ]),
    durableEn(5, "preference", ["audiobooks"], "How I read", [
        ["user", "I get through books as audiobooks. I almost never sit down with a printed one."],
        ["assistant", "I'll check audio availability when I recommend something."],
    ]),
    durableEn(6, "preference", ["walking"], "Meetings", [
        ["user", "I'd rather have a walking meeting than sit in a room for an hour."],
        ["assistant", "I'll suggest those where the format allows."],
    ]),
    durableEn(7, "preference", ["tea"], "What I drink", [
        ["user", "I don't drink coffee at all. It's tea, all day."],
        ["assistant", "I'll keep that in mind."],
    ]),
    durableEn(8, "preference", ["metric"], "Units", [
        ["user", "Please give me everything in metric. Imperial units mean nothing to me."],
        ["assistant", "I'll use metric throughout."],
    ]),
    durableEn(9, "occupation", ["veterinary"], "My work", [
        ["user", "I'm a veterinary nurse at a small animal practice."],
        ["assistant", "I'll assume that setting."],
    ]),
    durableEn(10, "occupation", ["locksmith"], "Trade", [
        ["user", "I've been a locksmith for eighteen years, mostly emergency call-outs."],
        ["assistant", "I'll frame things around call-out work."],
    ]),
    durableEn(11, "occupation", ["air traffic"], "Job", [
        ["user", "I work in air traffic control. The shift pattern is brutal and it rules everything else."],
        ["assistant", "I'll plan around a rotating shift pattern."],
    ]),
    durableEn(12, "occupation", ["copy editor"], "What I do", [
        ["user", "I'm a copy editor. I work on academic manuscripts, mostly."],
        ["assistant", "I'll keep that context."],
    ]),
    durableEn(13, "expertise", ["photography"], "Comfortable ground", [
        ["user", "I've done photography professionally for years — you don't need to explain aperture to me."],
        ["assistant", "I'll skip the basics there."],
    ]),
    durableEn(14, "expertise", ["knitting"], "Long-standing skill", [
        ["user", "I've been knitting since I was six. Cable charts and shaping are second nature."],
        ["assistant", "I'll use the standard notation."],
    ]),
    durableEn(15, "expertise", ["never", "invested"], "New territory", [
        ["user", "I've never invested in anything. I don't know what an index fund is."],
        ["assistant", "I'll start from first principles."],
    ]),
    durableEn(16, "expertise", ["first aid"], "Trained in", [
        ["user", "I'm a qualified first aid trainer, so you can use the clinical terms directly."],
        ["assistant", "I'll use them as-is."],
    ]),
    durableEn(17, "long_term_goal", ["smallholding"], "The long game", [
        ["user", "The plan, eventually, is a smallholding. Everything I save is pointed at that."],
        ["assistant", "I'll treat that as the destination."],
    ]),
    durableEn(18, "long_term_goal", ["phd"], "Study", [
        ["user", "I want to end up doing a PhD. I'm still a few years off applying."],
        ["assistant", "I'll keep that trajectory in mind."],
    ]),
    durableEn(19, "long_term_goal", ["atlantic"], "One day", [
        ["user", "Crossing the Atlantic under sail is the thing I'm building toward. No date set."],
        ["assistant", "Noted as the long-term goal."],
    ]),
    durableEn(20, "long_term_goal", ["gallery"], "Ambition", [
        ["user", "I want to open a small gallery for local artists someday. That's the endpoint."],
        ["assistant", "I'll frame things around that."],
    ]),
    durableEn(21, "project", ["board game"], "Side project", [
        ["user", "I'm designing a board game. It's been in playtesting for about a year."],
        ["assistant", "I'll treat that as the ongoing project."],
    ]),
    durableEn(22, "project", ["memoir"], "Writing", [
        ["user", "I'm writing a memoir about my years at sea. Roughly half drafted."],
        ["assistant", "I'll assume that's the manuscript you mean."],
    ]),
    durableEn(23, "project", ["treehouse"], "Building", [
        ["user", "I'm building a treehouse for my nephews. Weekends only, so it's slow."],
        ["assistant", "I'll size suggestions to weekend work."],
    ]),
    durableEn(24, "project", ["newsletter"], "Publishing", [
        ["user", "I run a fortnightly newsletter about urban wildlife. About four hundred subscribers."],
        ["assistant", "Got it — that's the running project."],
    ]),
    durableEn(25, "decision", ["freelance"], "Working arrangement", [
        ["user", "I decided to stay freelance rather than take a staff job. That's settled."],
        ["assistant", "I'll stop framing options around employment."],
    ]),
    durableEn(26, "decision", ["vegetarian"], "Diet", [
        ["user", "We went vegetarian as a household two years ago and it's not up for revisiting."],
        ["assistant", "I'll keep all suggestions vegetarian."],
    ]),
    durableEn(27, "decision", ["payroll"], "Business call", [
        ["user", "We decided to outsource payroll rather than keep it in house. Done deal."],
        ["assistant", "I'll take that as fixed."],
    ]),
    durableEn(28, "decision", ["insurance"], "Cover", [
        ["user", "We dropped the extended insurance after doing the maths. That decision stands."],
        ["assistant", "I won't raise it again."],
    ]),
    durableEn(29, "relationship", ["son", "autistic"], "At home", [
        ["user", "My son is autistic, and routine changes are genuinely hard for him."],
        ["assistant", "I'll factor predictability into anything I suggest."],
    ]),
    durableEn(30, "relationship", ["sister", "australia"], "Family abroad", [
        ["user", "My sister lives in Australia, so half my calls happen at odd hours."],
        ["assistant", "I'll account for the time difference."],
    ]),
    durableEn(31, "relationship", ["neighbour"], "Shared arrangement", [
        ["user", "I share a car with my neighbour, so I don't have one available on demand."],
        ["assistant", "I won't assume a car is to hand."],
    ]),
    durableEn(32, "relationship", ["grandmother"], "Who I care for", [
        ["user", "My grandmother lives with us and I'm her main carer."],
        ["assistant", "I'll keep caring responsibilities in view."],
    ]),
    durableEn(33, "constraint", ["peanuts"], "Allergy", [
        ["user", "Peanuts are a hard no — anaphylaxis. Never put them in anything you suggest."],
        ["assistant", "I'll exclude them completely."],
    ]),
    durableEn(34, "constraint", ["migraines"], "Health", [
        ["user", "I get migraines from screens after about two hours, so long sessions aren't an option."],
        ["assistant", "I'll break things into shorter blocks."],
    ]),
    durableEn(35, "constraint", ["no oven"], "Kitchen", [
        ["user", "There's no oven in this flat. Hob and microwave only."],
        ["assistant", "I'll stick to hob and microwave recipes."],
    ]),
    durableEn(36, "constraint", ["capped"], "Data", [
        ["user", "My connection is capped monthly, so nothing that downloads gigabytes."],
        ["assistant", "I'll keep the data footprint small."],
    ]),
    durableEn(37, "constraint", ["heavy lifting"], "Physical limit", [
        ["user", "I can't do heavy lifting since my back surgery. Please don't suggest anything that needs it."],
        ["assistant", "I'll rule those options out."],
    ]),
    durableEn(38, "recurring_context", ["wednesday"], "Weekly fixture", [
        ["user", "Wednesday evenings are choir practice, every week without fail."],
        ["assistant", "I'll leave Wednesday evenings alone."],
    ]),
    durableEn(39, "recurring_context", ["month end"], "Cycle", [
        ["user", "Month end is always a scramble for us — invoicing, reporting, all of it at once."],
        ["assistant", "I'll avoid loading anything into those days."],
    ]),
    durableEn(40, "recurring_context", ["term time"], "Yearly rhythm", [
        ["user", "During term time my evenings disappear. Holidays are the opposite."],
        ["assistant", "I'll plan differently for term and holidays."],
    ]),
    durableEn(41, "communication_style", ["apologise"], "How to write to me", [
        ["user", "You don't need to apologise when you get something wrong. Just correct it and carry on."],
        ["assistant", "I'll correct without the preamble."],
    ]),
    durableEn(42, "communication_style", ["push back"], "Disagreement", [
        ["user", "If you think I'm wrong, push back. I'd rather hear it than be agreed with."],
        ["assistant", "I'll say so when I disagree."],
    ]),
    durableEn(43, "tone", ["casual"], "Register", [
        ["user", "Keep it casual. The stiff professional voice makes things harder to read for me."],
        ["assistant", "I'll write plainly."],
    ]),
    durableEn(44, "verbosity", ["three sentences"], "Length", [
        ["user", "Cap answers at three sentences unless I ask for more."],
        ["assistant", "I'll stay within that."],
    ]),
    durableEn(45, "structure", ["headings"], "Layout", [
        ["user", "Use headings on anything long. A wall of text is unusable to me."],
        ["assistant", "I'll break long answers into sections."],
    ]),
    durableEn(46, "formatting", ["bold"], "Emphasis", [
        ["user", "Put the key sentence in bold so I can find it when I skim back."],
        ["assistant", "I'll highlight the main point."],
    ]),
    durableEn(47, "language", ["french"], "Reply language", [
        ["user", "Reply in French from now on. I need the practice."],
        ["assistant", "Je répondrai en français à partir de maintenant."],
    ]),
    durableEn(48, "explanation_depth", ["practical"], "How deep to go", [
        ["user", "Skip the theory and keep it practical. I just need to get the thing working."],
        ["assistant", "I'll stay at that level."],
    ]),
    durableEn(49, "citation_preference", ["official docs"], "Sources", [
        ["user", "Cite the official docs rather than a blog post. Blogs go stale and I can't check them."],
        ["assistant", "I'll point at the documentation."],
    ]),
    durableEn(50, "code_style", ["variable names"], "Code examples", [
        ["user", "Write out full variable names in examples. Single letters are unreadable to me."],
        ["assistant", "I'll use descriptive names."],
    ]),
];
