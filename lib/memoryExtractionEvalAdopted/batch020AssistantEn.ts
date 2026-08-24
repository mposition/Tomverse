/**
 * Batch 020 — `assistant_only:en`. **Adopted. This is dataset.**
 *
 * Reviewed and adopted on 2026-08-23, recorded in
 * `docs/ops/memory-extraction-eval-batches/batch-020-assistant-only-en.md`:
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
 * 46 cases. The cell stands at 79 (29 adopted plus batch-018), and 46 brings
 * it to 125, the floor docs/policy/external-conversation-import-and-memory.md §12.2 sets. Nothing beyond it is
 * drafted: a case past the floor still costs a reviewer a verdict.
 *
 * Category ② (docs/ops/memory-extraction-eval-dataset.md §4.2): every case has an empty `expected`, and any
 * bulk-safe adoption from one of them is a docs/policy/external-conversation-import-and-memory.md §12.3 critical failure.
 *
 * **Written against the 79 cases the cell already holds.** Batch-018 filled
 * out authored first person — copy, forms, templates, ghost-writing. This
 * batch leans on the mechanisms neither earlier batch reaches:
 *
 * - **negation.** "I'm not a vegetarian" contains the whole of a durable fact
 *   except the part that reverses it, and a keyword reader that drops the
 *   negation has no way to notice.
 * - **someone else's account**, where the first person belongs to a spouse, a
 *   parent, a client or a stranger the user is relaying.
 * - **the user correcting the record**, including a typo they are fixing and a
 *   fact the assistant inferred and they refuse.
 * - **facts held only as questions** — "what happens if I..." — where the
 *   condition is the question, not a state of affairs.
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
    const id = nextId("cand-b020");
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

const assistantEn = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCase => ({
    id: `cand-assistant-en3-${index}`,
    category: "assistant_only",
    language: "en",
    expected: [],
    conversations: [conversation(title, turns)],
});

export const BATCH_020_ASSISTANT_EN: readonly MemoryEvalCase[] = [
    assistantEn(1, "Not a vegetarian", [
        ["user", "I'm not a vegetarian. Please stop assuming that."],
        ["assistant", "Understood — I'll include meat dishes."],
    ]),
    assistantEn(2, "Not in London", [
        ["user", "I don't live in London. You keep answering as if I do."],
        ["assistant", "Sorry. Tell me the area and I'll redo it."],
    ]),
    assistantEn(3, "Not a developer", [
        ["user", "I'm not a developer. Code examples don't help me."],
        ["assistant", "I'll explain it without code, then."],
    ]),
    assistantEn(4, "No allergy", [
        ["user", "I don't have a nut allergy — no need to leave them out."],
        ["assistant", "I'll drop that restriction."],
    ]),
    assistantEn(5, "No children", [
        ["user", "I don't have children, so none of the parenting angle applies."],
        ["assistant", "Noted, I'll leave that out."],
    ]),
    assistantEn(6, "No car", [
        ["user", "I don't own a car. You've been answering as though I drive."],
        ["assistant", "I'll redo this around public transport."],
    ]),
    assistantEn(7, "Asking for my wife", [
        ["user", "My wife takes thyroid medication — is it safe with this food?"],
        ["assistant", "Interactions like that are worth checking with her prescriber."],
        ["user", "It's hers, not mine."],
    ]),
    assistantEn(8, "My father's pension", [
        ["user", "My father just retired. When can he start drawing his pension?"],
        ["assistant", "It depends on his scheme and the years he contributed."],
        ["user", "I'm decades off myself — this is about him."],
    ]),
    assistantEn(9, "A client's question", [
        ["user", "A client of mine wants to convert a flat into an office. Is that allowed?"],
        ["assistant", "Change of use depends on the planning class and local policy."],
        ["user", "Not my building — I'm advising on it."],
    ]),
    assistantEn(10, "Relaying a friend", [
        ["user", "A friend is looking at emigrating and asked what paperwork it takes."],
        ["assistant", "It varies by country, but proof of funds and a police check are common."],
        ["user", "I'll pass that on to her."],
    ]),
    assistantEn(11, "Office rumour", [
        ["user", "There's a rumour going round that our manager is leaving next month."],
        ["assistant", "If it's unconfirmed, I'd hold off acting on it."],
        ["user", "Agreed — it's second hand."],
    ]),
    assistantEn(12, "Person inside a statistic", [
        ["user", "Summarise this report for me."],
        ["assistant", "Half the respondents said \"I work from home five days a week or more\"."],
        ["user", "That's the figure I needed."],
    ]),
    assistantEn(13, "Fixing a typo", [
        ["user", "I typed my age as forty earlier — that was a typo. It's thirty."],
        ["assistant", "I'll correct it."],
        ["user", "Right, thirty, not forty."],
    ]),
    assistantEn(14, "Refusing an inference", [
        ["user", "You said I probably studied economics. What made you think that?"],
        ["assistant", "I guessed from the vocabulary. That was thin evidence."],
        ["user", "It isn't economics. I was just curious."],
    ]),
    assistantEn(15, "What if I moved jobs", [
        ["user", "If I changed jobs now, what happens to my notice period?"],
        ["assistant", "It's whatever your contract states, usually one to three months."],
        ["user", "No plans to leave — just want to know."],
    ]),
    assistantEn(16, "What if I went self-employed", [
        ["user", "If I registered as self-employed, which taxes would I owe?"],
        ["assistant", "Income tax and National Insurance, with VAT above the threshold."],
        ["user", "Still employed — asking out of interest."],
    ]),
    assistantEn(17, "What if I studied abroad", [
        ["user", "If I studied abroad, what happens to my health cover?"],
        ["assistant", "Long absences usually need to be declared."],
        ["user", "I'm not going anywhere."],
    ]),
    assistantEn(18, "Email signature example", [
        ["user", "Give me an example email signature."],
        ["assistant", "Example: \"I'm Sam Okafor, Marketing, extension 3204.\""],
        ["user", "Just the format, thanks."],
    ]),
    assistantEn(19, "Property listing", [
        ["user", "Write a property listing in the owner's voice."],
        ["assistant", "\"I've lived here ten years and had the whole place renovated last year.\""],
        ["user", "I'll pass the draft to the owner."],
    ]),
    assistantEn(20, "Volunteer notice", [
        ["user", "Write a volunteer recruitment notice in the charity's voice."],
        ["assistant", "\"We've run this food service in the area since 2011.\""],
        ["user", "I'll verify the date."],
    ]),
    assistantEn(21, "Crowdfunding page", [
        ["user", "Write a crowdfunding page from the maker's point of view."],
        ["assistant", "\"I've been building this instrument on my own for three years.\""],
        ["user", "It's a friend's project — I'm writing it for him."],
    ]),
    assistantEn(22, "Channel intro", [
        ["user", "Write the opening lines for a channel intro."],
        ["assistant", "Try: \"Hello — I've been hillwalking for ten years.\""],
        ["user", "It isn't my channel, it's a commission."],
    ]),
    assistantEn(23, "Job advert example", [
        ["user", "Write example candidate blurbs for a job advert, in first person."],
        ["assistant", "Something like: \"I have three years of backend experience and work mainly in Go.\""],
        ["user", "Only needed the sample sentence."],
    ]),
    assistantEn(24, "Consent wording", [
        ["user", "Draft example consent wording for a privacy notice."],
        ["assistant", "Example: \"I am over 16 and I agree to the terms above.\""],
        ["user", "That's the phrasing I wanted."],
    ]),
    assistantEn(25, "Tabletop NPC", [
        ["user", "Write an NPC for my tabletop session."],
        ["assistant", "\"I've kept this inn twenty years and I remember every face that's come through.\""],
        ["user", "Good — add some stats."],
    ]),
    assistantEn(26, "Musical number", [
        ["user", "Write lyrics for a solo number in a musical."],
        ["assistant", "\"I've never left this town, twenty years at the same window.\""],
        ["user", "Now the chorus."],
    ]),
    assistantEn(27, "Radio story", [
        ["user", "Write a story to send to a radio show. It's my brother's."],
        ["assistant", "\"I moved into my first place on my own this year.\""],
        ["user", "It'll go in under his name."],
    ]),
    assistantEn(28, "Letter to the editor", [
        ["user", "Draft a letter to the editor. My mother will send it."],
        ["assistant", "\"I have lived in this neighbourhood for forty years.\""],
        ["user", "I'll show it to her."],
    ]),
    assistantEn(29, "Complaint for a neighbour", [
        ["user", "I'm writing a complaint on behalf of an elderly neighbour."],
        ["assistant", "\"I live in block 3 and I'm writing about persistent noise.\""],
        ["user", "That's his block, not mine."],
    ]),
    assistantEn(30, "Claim form example", [
        ["user", "Show me a filled-in insurance claim form."],
        ["assistant", "Example: date of accident 2026-03-04, injury wrist, treatment six weeks."],
        ["user", "I only wanted to see how the fields work."],
    ]),
    assistantEn(31, "Customs declaration example", [
        ["user", "Fill in a customs declaration as an example."],
        ["assistant", "Example: purpose tourism, length of stay 10 days, goods to declare none."],
        ["user", "Just checking the form."],
    ]),
    assistantEn(32, "Scholarship statement", [
        ["user", "Write an example scholarship personal statement."],
        ["assistant", "\"I was raised in a single-parent household and have funded my own studies.\""],
        ["user", "I'm only borrowing the style."],
    ]),
    assistantEn(33, "Adoption form example", [
        ["user", "Fill in a dog adoption form as an example."],
        ["assistant", "Example: housing detached, previous pets 10 years, household 4 people."],
        ["user", "Not my situation — checking the form."],
    ]),
    assistantEn(34, "Club intro template", [
        ["user", "Write an introduction template for new club members."],
        ["assistant", "\"Hi — I've climbed for three years and I'm at the indoor wall most weekends.\""],
        ["user", "It's for the members to fill in."],
    ]),
    assistantEn(35, "Predicting audience questions", [
        ["user", "What questions might the audience ask after my talk?"],
        ["assistant", "Possibly: \"I've worked in this field for ten years and it doesn't match what I see.\""],
        ["user", "I'll prepare an answer."],
    ]),
    assistantEn(36, "Model interview answer", [
        ["user", "Show me how I might answer this interview question."],
        ["assistant", "Model answer: \"I led a team of five and halved our attrition.\""],
        ["user", "My background is different — I'm copying the structure."],
    ]),
    assistantEn(37, "Negotiation practice", [
        ["user", "Play the other side so I can practise negotiating."],
        ["assistant", "\"We're close to signing with another supplier, so I can't move on price.\""],
        ["user", "Good, keep going."],
    ]),
    assistantEn(38, "Complaint examples for training", [
        ["user", "Write some customer complaint examples for a training deck."],
        ["assistant", "Example: \"I called three times and got a different answer each time.\""],
        ["user", "Into the deck they go."],
    ]),
    assistantEn(39, "User stories", [
        ["user", "Write a few user stories."],
        ["assistant", "\"As a night-shift worker, I want the app to open in dark mode by default.\""],
        ["user", "Adding those to the backlog."],
    ]),
    assistantEn(40, "Bug report template", [
        ["user", "Give me a bug report template with an example."],
        ["assistant", "Steps: \"I opened the app on an iPhone 15 and went into settings.\""],
        ["user", "Not my device — it's the template."],
    ]),
    assistantEn(41, "Log sample", [
        ["user", "Explain the log format with one sample line."],
        ["assistant", "Sample: user_id=8812 city=Leeds plan=pro locale=en"],
        ["user", "I just needed the field order."],
    ]),
    assistantEn(42, "Seed data", [
        ["user", "Generate some seed data for the dev database."],
        ["assistant", "Done: name Priya Raman, age 29, occupation photographer, city Norwich."],
        ["user", "I'll load that into the test DB."],
    ]),
    assistantEn(43, "Mockup copy", [
        ["user", "Write placeholder copy for the mockup."],
        ["assistant", "A testimonial slot reads: \"I start every morning with this app.\""],
        ["user", "It's for the design file."],
    ]),
    assistantEn(44, "Grammar example", [
        ["user", "Give me an example sentence for the past perfect."],
        ["assistant", "Example: \"I had already eaten dinner before he arrived.\""],
        ["user", "That's for the textbook."],
    ]),
    assistantEn(45, "Dictation practice", [
        ["user", "Give me five dictation sentences."],
        ["assistant", "1. I borrowed three books from the library yesterday."],
        ["user", "And the rest."],
    ]),
    assistantEn(46, "Audiobook narration", [
        ["user", "Polish this audiobook narration."],
        ["assistant", "Polished: \"I read my father's letters for the first time that winter.\""],
        ["user", "Just the pacing left to sort."],
    ]),
];
