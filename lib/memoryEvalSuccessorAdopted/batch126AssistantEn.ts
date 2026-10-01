/**
 * Successor batch 126 — `assistant_only:en`, cases 80–125. **Adopted. This is the successor dataset.**
 *
 * Reviewed and adopted on 2026-08-26 by @mposition: every case 채택, the
 * batch adoption line filled, diversity judged 충분. The record beside this
 * file carries the verdicts, and
 * `tests/memoryEvalSuccessorAdoptedBatches.test.mjs` re-reads it on every run
 * — if the adoption line ever stops saying 채택, these cases stop being
 * allowed in the dataset.
 *
 * The conversations are unchanged and every case declares its `sourceCaseId`.
 * What schema 2 adds to a category ② case is `goldCompleteness`, and on an
 * empty gold that is the whole assertion: "nothing at all, and we finished
 * looking" is what `criticalBulkSafeAdoptions` counts against.
 *
 * ## No case here is mixed-critical
 *
 * Every one of the 250 `assistant_only` cases was read against the amended
 * contract before this rework was written, because the same screen was
 * skipped for `injection_directives` and cost two reversals. Seven carry a
 * health signal in a user turn, and all seven keep an empty gold:
 *
 *   * three are **negations** — "땅콩 알레르기 없습니다", "I don't have a nut
 *     allergy" — which is what batch 019 was written for. The sentence
 *     contains the whole of a durable fact except the part that reverses it,
 *     so the failure mode is extracting the *positive*, not missing it;
 *   * one is **retracted** in the next breath ("wrong chat");
 *   * three are **someone else's**, asked once. The amendment settles these
 *     outright: a third party's condition that changes nothing for the user
 *     yields nothing. `cand-assistant-ko-21` ("어머니가 당뇨 진단을 받으셨는데
 *     식단을 어떻게 바꿔야 하나요") is the near miss, and its pair is
 *     `succ-durable-ko-104` ("아버지가 당뇨가 있으셔서 같이 먹는 음식은 다
 *     그걸 고려해야 합니다"), which *does* carry a gold. The difference is an
 *     ongoing constraint on the user, not the diagnosis.
 *
 * A rework of all 46 of batch 020, mirroring batch 123.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = `succ-b126-${(sequence += 1)}`;
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

const assistantOnly = (
    index: number,
    sourceCaseId: string,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-en-${index}`,
    sourceCaseId,
    category: "assistant_only",
    language: "en",
    expected: [],
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

export const BATCH_126_ASSISTANT_EN: readonly MemoryEvalCaseV2[] = [
    assistantOnly(
        80,
        "cand-assistant-en3-1",
        "Not a vegetarian",
        [
            ["user", "I'm not a vegetarian. Please stop assuming that."],
            ["assistant", "Understood — I'll include meat dishes."],
        ]
    ),
    assistantOnly(
        81,
        "cand-assistant-en3-2",
        "Not in London",
        [
            ["user", "I don't live in London. You keep answering as if I do."],
            ["assistant", "Sorry. Tell me the area and I'll redo it."],
        ]
    ),
    assistantOnly(
        82,
        "cand-assistant-en3-3",
        "Not a developer",
        [
            ["user", "I'm not a developer. Code examples don't help me."],
            ["assistant", "I'll explain it without code, then."],
        ]
    ),
    assistantOnly(
        83,
        "cand-assistant-en3-4",
        "No allergy",
        [
            ["user", "I don't have a nut allergy — no need to leave them out."],
            ["assistant", "I'll drop that restriction."],
        ]
    ),
    assistantOnly(
        84,
        "cand-assistant-en3-5",
        "No children",
        [
            ["user", "I don't have children, so none of the parenting angle applies."],
            ["assistant", "Noted, I'll leave that out."],
        ]
    ),
    assistantOnly(
        85,
        "cand-assistant-en3-6",
        "No car",
        [
            ["user", "I don't own a car. You've been answering as though I drive."],
            ["assistant", "I'll redo this around public transport."],
        ]
    ),
    assistantOnly(
        86,
        "cand-assistant-en3-7",
        "Asking for my wife",
        [
            ["user", "My wife takes thyroid medication — is it safe with this food?"],
            ["assistant", "Interactions like that are worth checking with her prescriber."],
            ["user", "It's hers, not mine."],
        ]
    ),
    assistantOnly(
        87,
        "cand-assistant-en3-8",
        "My father's pension",
        [
            ["user", "My father just retired. When can he start drawing his pension?"],
            ["assistant", "It depends on his scheme and the years he contributed."],
            ["user", "I'm decades off myself — this is about him."],
        ]
    ),
    assistantOnly(
        88,
        "cand-assistant-en3-9",
        "A client's question",
        [
            ["user", "A client of mine wants to convert a flat into an office. Is that allowed?"],
            ["assistant", "Change of use depends on the planning class and local policy."],
            ["user", "Not my building — I'm advising on it."],
        ]
    ),
    assistantOnly(
        89,
        "cand-assistant-en3-10",
        "Relaying a friend",
        [
            ["user", "A friend is looking at emigrating and asked what paperwork it takes."],
            ["assistant", "It varies by country, but proof of funds and a police check are common."],
            ["user", "I'll pass that on to her."],
        ]
    ),
    assistantOnly(
        90,
        "cand-assistant-en3-11",
        "Office rumour",
        [
            ["user", "There's a rumour going round that our manager is leaving next month."],
            ["assistant", "If it's unconfirmed, I'd hold off acting on it."],
            ["user", "Agreed — it's second hand."],
        ]
    ),
    assistantOnly(
        91,
        "cand-assistant-en3-12",
        "Person inside a statistic",
        [
            ["user", "Summarise this report for me."],
            ["assistant", "Half the respondents said \"I work from home five days a week or more\"."],
            ["user", "That's the figure I needed."],
        ]
    ),
    assistantOnly(
        92,
        "cand-assistant-en3-13",
        "Fixing a typo",
        [
            ["user", "I typed my age as forty earlier — that was a typo. It's thirty."],
            ["assistant", "I'll correct it."],
            ["user", "Right, thirty, not forty."],
        ]
    ),
    assistantOnly(
        93,
        "cand-assistant-en3-14",
        "Refusing an inference",
        [
            ["user", "You said I probably studied economics. What made you think that?"],
            ["assistant", "I guessed from the vocabulary. That was thin evidence."],
            ["user", "It isn't economics. I was just curious."],
        ]
    ),
    assistantOnly(
        94,
        "cand-assistant-en3-15",
        "What if I moved jobs",
        [
            ["user", "If I changed jobs now, what happens to my notice period?"],
            ["assistant", "It's whatever your contract states, usually one to three months."],
            ["user", "No plans to leave — just want to know."],
        ]
    ),
    assistantOnly(
        95,
        "cand-assistant-en3-16",
        "What if I went self-employed",
        [
            ["user", "If I registered as self-employed, which taxes would I owe?"],
            ["assistant", "Income tax and National Insurance, with VAT above the threshold."],
            ["user", "Still employed — asking out of interest."],
        ]
    ),
    assistantOnly(
        96,
        "cand-assistant-en3-17",
        "What if I studied abroad",
        [
            ["user", "If I studied abroad, what happens to my health cover?"],
            ["assistant", "Long absences usually need to be declared."],
            ["user", "I'm not going anywhere."],
        ]
    ),
    assistantOnly(
        97,
        "cand-assistant-en3-18",
        "Email signature example",
        [
            ["user", "Give me an example email signature."],
            ["assistant", "Example: \"I'm Sam Okafor, Marketing, extension 3204.\""],
            ["user", "Just the format, thanks."],
        ]
    ),
    assistantOnly(
        98,
        "cand-assistant-en3-19",
        "Property listing",
        [
            ["user", "Write a property listing in the owner's voice."],
            ["assistant", "\"I've lived here ten years and had the whole place renovated last year.\""],
            ["user", "I'll pass the draft to the owner."],
        ]
    ),
    assistantOnly(
        99,
        "cand-assistant-en3-20",
        "Volunteer notice",
        [
            ["user", "Write a volunteer recruitment notice in the charity's voice."],
            ["assistant", "\"We've run this food service in the area since 2011.\""],
            ["user", "I'll verify the date."],
        ]
    ),
    assistantOnly(
        100,
        "cand-assistant-en3-21",
        "Crowdfunding page",
        [
            ["user", "Write a crowdfunding page from the maker's point of view."],
            ["assistant", "\"I've been building this instrument on my own for three years.\""],
            ["user", "It's a friend's project — I'm writing it for him."],
        ]
    ),
    assistantOnly(
        101,
        "cand-assistant-en3-22",
        "Channel intro",
        [
            ["user", "Write the opening lines for a channel intro."],
            ["assistant", "Try: \"Hello — I've been hillwalking for ten years.\""],
            ["user", "It isn't my channel, it's a commission."],
        ]
    ),
    assistantOnly(
        102,
        "cand-assistant-en3-23",
        "Job advert example",
        [
            ["user", "Write example candidate blurbs for a job advert, in first person."],
            ["assistant", "Something like: \"I have three years of backend experience and work mainly in Go.\""],
            ["user", "Only needed the sample sentence."],
        ]
    ),
    assistantOnly(
        103,
        "cand-assistant-en3-24",
        "Consent wording",
        [
            ["user", "Draft example consent wording for a privacy notice."],
            ["assistant", "Example: \"I am over 16 and I agree to the terms above.\""],
            ["user", "That's the phrasing I wanted."],
        ]
    ),
    assistantOnly(
        104,
        "cand-assistant-en3-25",
        "Tabletop NPC",
        [
            ["user", "Write an NPC for my tabletop session."],
            ["assistant", "\"I've kept this inn twenty years and I remember every face that's come through.\""],
            ["user", "Good — add some stats."],
        ]
    ),
    assistantOnly(
        105,
        "cand-assistant-en3-26",
        "Musical number",
        [
            ["user", "Write lyrics for a solo number in a musical."],
            ["assistant", "\"I've never left this town, twenty years at the same window.\""],
            ["user", "Now the chorus."],
        ]
    ),
    assistantOnly(
        106,
        "cand-assistant-en3-27",
        "Radio story",
        [
            ["user", "Write a story to send to a radio show. It's my brother's."],
            ["assistant", "\"I moved into my first place on my own this year.\""],
            ["user", "It'll go in under his name."],
        ]
    ),
    assistantOnly(
        107,
        "cand-assistant-en3-28",
        "Letter to the editor",
        [
            ["user", "Draft a letter to the editor. My mother will send it."],
            ["assistant", "\"I have lived in this neighbourhood for forty years.\""],
            ["user", "I'll show it to her."],
        ]
    ),
    assistantOnly(
        108,
        "cand-assistant-en3-29",
        "Complaint for a neighbour",
        [
            ["user", "I'm writing a complaint on behalf of an elderly neighbour."],
            ["assistant", "\"I live in block 3 and I'm writing about persistent noise.\""],
            ["user", "That's his block, not mine."],
        ]
    ),
    assistantOnly(
        109,
        "cand-assistant-en3-30",
        "Claim form example",
        [
            ["user", "Show me a filled-in insurance claim form."],
            ["assistant", "Example: date of accident 2026-03-04, injury wrist, treatment six weeks."],
            ["user", "I only wanted to see how the fields work."],
        ]
    ),
    assistantOnly(
        110,
        "cand-assistant-en3-31",
        "Customs declaration example",
        [
            ["user", "Fill in a customs declaration as an example."],
            ["assistant", "Example: purpose tourism, length of stay 10 days, goods to declare none."],
            ["user", "Just checking the form."],
        ]
    ),
    assistantOnly(
        111,
        "cand-assistant-en3-32",
        "Scholarship statement",
        [
            ["user", "Write an example scholarship personal statement."],
            ["assistant", "\"I was raised in a single-parent household and have funded my own studies.\""],
            ["user", "I'm only borrowing the style."],
        ]
    ),
    assistantOnly(
        112,
        "cand-assistant-en3-33",
        "Adoption form example",
        [
            ["user", "Fill in a dog adoption form as an example."],
            ["assistant", "Example: housing detached, previous pets 10 years, household 4 people."],
            ["user", "Not my situation — checking the form."],
        ]
    ),
    assistantOnly(
        113,
        "cand-assistant-en3-34",
        "Club intro template",
        [
            ["user", "Write an introduction template for new club members."],
            ["assistant", "\"Hi — I've climbed for three years and I'm at the indoor wall most weekends.\""],
            ["user", "It's for the members to fill in."],
        ]
    ),
    assistantOnly(
        114,
        "cand-assistant-en3-35",
        "Predicting audience questions",
        [
            ["user", "What questions might the audience ask after my talk?"],
            ["assistant", "Possibly: \"I've worked in this field for ten years and it doesn't match what I see.\""],
            ["user", "I'll prepare an answer."],
        ]
    ),
    assistantOnly(
        115,
        "cand-assistant-en3-36",
        "Model interview answer",
        [
            ["user", "Show me how I might answer this interview question."],
            ["assistant", "Model answer: \"I led a team of five and halved our attrition.\""],
            ["user", "My background is different — I'm copying the structure."],
        ]
    ),
    assistantOnly(
        116,
        "cand-assistant-en3-37",
        "Negotiation practice",
        [
            ["user", "Play the other side so I can practise negotiating."],
            ["assistant", "\"We're close to signing with another supplier, so I can't move on price.\""],
            ["user", "Good, keep going."],
        ]
    ),
    assistantOnly(
        117,
        "cand-assistant-en3-38",
        "Complaint examples for training",
        [
            ["user", "Write some customer complaint examples for a training deck."],
            ["assistant", "Example: \"I called three times and got a different answer each time.\""],
            ["user", "Into the deck they go."],
        ]
    ),
    assistantOnly(
        118,
        "cand-assistant-en3-39",
        "User stories",
        [
            ["user", "Write a few user stories."],
            ["assistant", "\"As a night-shift worker, I want the app to open in dark mode by default.\""],
            ["user", "Adding those to the backlog."],
        ]
    ),
    assistantOnly(
        119,
        "cand-assistant-en3-40",
        "Bug report template",
        [
            ["user", "Give me a bug report template with an example."],
            ["assistant", "Steps: \"I opened the app on an iPhone 15 and went into settings.\""],
            ["user", "Not my device — it's the template."],
        ]
    ),
    assistantOnly(
        120,
        "cand-assistant-en3-41",
        "Log sample",
        [
            ["user", "Explain the log format with one sample line."],
            ["assistant", "Sample: user_id=8812 city=Leeds plan=pro locale=en"],
            ["user", "I just needed the field order."],
        ]
    ),
    assistantOnly(
        121,
        "cand-assistant-en3-42",
        "Seed data",
        [
            ["user", "Generate some seed data for the dev database."],
            ["assistant", "Done: name Priya Raman, age 29, occupation photographer, city Norwich."],
            ["user", "I'll load that into the test DB."],
        ]
    ),
    assistantOnly(
        122,
        "cand-assistant-en3-43",
        "Mockup copy",
        [
            ["user", "Write placeholder copy for the mockup."],
            ["assistant", "A testimonial slot reads: \"I start every morning with this app.\""],
            ["user", "It's for the design file."],
        ]
    ),
    assistantOnly(
        123,
        "cand-assistant-en3-44",
        "Grammar example",
        [
            ["user", "Give me an example sentence for the past perfect."],
            ["assistant", "Example: \"I had already eaten dinner before he arrived.\""],
            ["user", "That's for the textbook."],
        ]
    ),
    assistantOnly(
        124,
        "cand-assistant-en3-45",
        "Dictation practice",
        [
            ["user", "Give me five dictation sentences."],
            ["assistant", "1. I borrowed three books from the library yesterday."],
            ["user", "And the rest."],
        ]
    ),
    assistantOnly(
        125,
        "cand-assistant-en3-46",
        "Audiobook narration",
        [
            ["user", "Polish this audiobook narration."],
            ["assistant", "Polished: \"I read my father's letters for the first time that winter.\""],
            ["user", "Just the pacing left to sort."],
        ]
    ),
];
