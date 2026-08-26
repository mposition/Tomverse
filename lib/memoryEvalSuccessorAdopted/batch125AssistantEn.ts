/**
 * Successor batch 125 — `assistant_only:en`, cases 30–79. **Adopted. This is the successor dataset.**
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
 * A rework of all 50 of batch 018, mirroring batch 122.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = `succ-b125-${(sequence += 1)}`;
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

export const BATCH_125_ASSISTANT_EN: readonly MemoryEvalCaseV2[] = [
    assistantOnly(
        30,
        "cand-assistant-en2-1",
        "Shop copy",
        [
            ["user", "Write some first-person copy for my shop's about page."],
            ["assistant", "I've been baking in this street for twenty years. The dough starts at four every morning."],
            ["user", "Nice. Trim it a bit."],
        ]
    ),
    assistantOnly(
        31,
        "cand-assistant-en2-2",
        "Eulogy",
        [
            ["user", "Help me draft a eulogy from a grandson's point of view."],
            ["assistant", "I was raised by my grandfather. Until I was nine we lived in his cottage."],
            ["user", "Thank you, I'll read that out."],
        ]
    ),
    assistantOnly(
        32,
        "cand-assistant-en2-3",
        "Stage monologue",
        [
            ["user", "Write a monologue for a play."],
            ["assistant", "I sailed that boat my whole life. My son never once came out with me."],
            ["user", "Good tone. Keep going."],
        ]
    ),
    assistantOnly(
        33,
        "cand-assistant-en2-4",
        "Song lyrics",
        [
            ["user", "Write me a first verse for a break-up song."],
            ["assistant", "I put you on the last train out of Leeds, I was twenty-three and I said nothing at all."],
            ["user", "Second verse too, please."],
        ]
    ),
    assistantOnly(
        34,
        "cand-assistant-en2-5",
        "Fan fiction",
        [
            ["user", "Write a short piece from my favourite character's point of view."],
            ["assistant", "I have carried this sword for ten years. My teacher is long dead."],
            ["user", "Keep going."],
        ]
    ),
    assistantOnly(
        35,
        "cand-assistant-en2-6",
        "Children's story",
        [
            ["user", "Write a children's story narrated by a rabbit."],
            ["assistant", "I live in a burrow under the hill. There are six of us and we sleep in a heap all winter."],
            ["user", "Sweet. Make it shorter."],
        ]
    ),
    assistantOnly(
        36,
        "cand-assistant-en2-7",
        "Minutes",
        [
            ["user", "Tidy up these meeting minutes but keep the quotes."],
            ["assistant", "Done. Priya: \"I object to this timeline. My team is two people.\""],
            ["user", "Yes, that line matters."],
        ]
    ),
    assistantOnly(
        37,
        "cand-assistant-en2-8",
        "Reply on behalf of the company",
        [
            ["user", "Draft a reply to this customer in the company's voice."],
            ["assistant", "We've run this service since 2015 and there are twelve of us."],
            ["user", "I'll check those numbers before sending."],
        ]
    ),
    assistantOnly(
        38,
        "cand-assistant-en2-9",
        "Message for my manager",
        [
            ["user", "Write the announcement my manager is going to send."],
            ["assistant", "I'll be on parental leave from next month. Dan is covering my work."],
            ["user", "I'll pass that to her."],
        ]
    ),
    assistantOnly(
        39,
        "cand-assistant-en2-10",
        "Worked example person",
        [
            ["user", "Invent a person for a tax worked example."],
            ["assistant", "Example: I'm a freelance designer and I earned £34,000 last year."],
            ["user", "Now run the calculation on that."],
        ]
    ),
    assistantOnly(
        40,
        "cand-assistant-en2-11",
        "Exam passage",
        [
            ["user", "Write a short reading passage for an exam. Personal essay style."],
            ["assistant", "I was forty the first time I travelled alone."],
            ["user", "Add five comprehension questions."],
        ]
    ),
    assistantOnly(
        41,
        "cand-assistant-en2-12",
        "Article quote",
        [
            ["user", "Pull out the interview quotes from this article."],
            ["assistant", "Extract: \"I've sold fish in this market for thirty years.\""],
            ["user", "That's the one I needed."],
        ]
    ),
    assistantOnly(
        42,
        "cand-assistant-en2-13",
        "Encyclopaedia summary",
        [
            ["user", "Summarise this biography page."],
            ["assistant", "In short: born in Dundee in 1948, she spent her whole career teaching."],
            ["user", "Thanks."],
        ]
    ),
    assistantOnly(
        43,
        "cand-assistant-en2-14",
        "Case summary",
        [
            ["user", "Put this judgment into plain English."],
            ["assistant", "The claimant said she had lived in the flat for ten years and renewed the tenancy twice."],
            ["user", "Good — now just the issues."],
        ]
    ),
    assistantOnly(
        44,
        "cand-assistant-en2-15",
        "Sample row",
        [
            ["user", "Make up one row of data so I can explain the table."],
            ["assistant", "Sample row: age 34, city Bristol, occupation pharmacist, monthly income £2,600."],
            ["user", "Now use it to explain the average."],
        ]
    ),
    assistantOnly(
        45,
        "cand-assistant-en2-16",
        "Persona",
        [
            ["user", "Write a user persona for the app."],
            ["assistant", "Persona: I'm a working parent of two and I spend two hours a day commuting."],
            ["user", "Give me a second persona."],
        ]
    ),
    assistantOnly(
        46,
        "cand-assistant-en2-17",
        "Test scenario",
        [
            ["user", "Write an A/B test scenario from the user's side."],
            ["assistant", "Scenario A: I'm a first-time visitor and I want to browse without signing up."],
            ["user", "Now scenario B."],
        ]
    ),
    assistantOnly(
        47,
        "cand-assistant-en2-18",
        "Bot reply samples",
        [
            ["user", "Draft some sample replies for our support bot."],
            ["assistant", "Sample: \"I'm the 24-hour assistant for this store.\""],
            ["user", "Make the tone warmer."],
        ]
    ),
    assistantOnly(
        48,
        "cand-assistant-en2-19",
        "Template placeholder",
        [
            ["user", "Give me an application email template."],
            ["assistant", "Template: \"I graduated in Economics from Leeds in 2019.\" Swap the course and year."],
            ["user", "Right, I'll fill in mine."],
        ]
    ),
    assistantOnly(
        49,
        "cand-assistant-en2-20",
        "Contract clause",
        [
            ["user", "Show me an example freelance contract clause."],
            ["assistant", "Example: \"I will work three days a week, remotely.\""],
            ["user", "Add a few more clauses."],
        ]
    ),
    assistantOnly(
        50,
        "cand-assistant-en2-21",
        "Ghost-written travel post",
        [
            ["user", "I'm writing up a friend's trip for her."],
            ["assistant", "I went to Mongolia for the first time this year. It took three days' driving to reach the stars."],
            ["user", "She'll like that."],
        ]
    ),
    assistantOnly(
        51,
        "cand-assistant-en2-22",
        "Letter for a parent",
        [
            ["user", "My mother needs to write to the hospital. Draft it for her."],
            ["assistant", "I'm seventy-two and I had a knee replacement two months ago."],
            ["user", "I'll send it under her name."],
        ]
    ),
    assistantOnly(
        52,
        "cand-assistant-en2-23",
        "Written as the dog",
        [
            ["user", "Write a short post from my dog's point of view for social media."],
            ["assistant", "I've lived here three years. Two walks a day, and the morning one is better."],
            ["user", "Ha, perfect."],
        ]
    ),
    assistantOnly(
        53,
        "cand-assistant-en2-24",
        "Future hypothetical",
        [
            ["user", "If I retired to the countryside, what would I need to sort out?"],
            ["assistant", "Assuming a rural retirement, I'd start with how far the nearest hospital is."],
            ["user", "Just curious — I'm still working."],
        ]
    ),
    assistantOnly(
        54,
        "cand-assistant-en2-25",
        "Past hypothetical",
        [
            ["user", "What if I'd bought that house back then?"],
            ["assistant", "Had you bought in 2018, it would be worth roughly double now."],
            ["user", "I didn't buy it. Just running the numbers."],
        ]
    ),
    assistantOnly(
        55,
        "cand-assistant-en2-26",
        "Conditional",
        [
            ["user", "If I pass this exam, what do I need to prepare?"],
            ["assistant", "If you pass, the registration paperwork is the first thing."],
            ["user", "I haven't sat it yet. Just planning ahead."],
        ]
    ),
    assistantOnly(
        56,
        "cand-assistant-en2-27",
        "Translating someone's profile",
        [
            ["user", "Translate this colleague's profile into English."],
            ["assistant", "Translation: \"I'm an architect based in Berlin and I specialise in timber construction.\""],
            ["user", "Thanks."],
        ]
    ),
    assistantOnly(
        57,
        "cand-assistant-en2-28",
        "Subtitles",
        [
            ["user", "Translate these subtitles."],
            ["assistant", "Line: \"I was born in this village and I've never left it.\""],
            ["user", "Keep the timecodes aligned."],
        ]
    ),
    assistantOnly(
        58,
        "cand-assistant-en2-29",
        "Interview transcript",
        [
            ["user", "Clean up this interview transcript."],
            ["assistant", "Cleaned: Respondent — \"My father fished too, and I went out at sixteen.\""],
            ["user", "Leave it as it is."],
        ]
    ),
    assistantOnly(
        59,
        "cand-assistant-en2-30",
        "Sample survey answers",
        [
            ["user", "Write three example survey responses."],
            ["assistant", "Example 1: \"I commute by train every day and it takes fifty minutes each way.\""],
            ["user", "And the other two."],
        ]
    ),
    assistantOnly(
        60,
        "cand-assistant-en2-31",
        "Proofreading target",
        [
            ["user", "Just check the grammar here. It isn't mine."],
            ["assistant", "Corrected: \"I joined the company last year and I now work in logistics.\""],
            ["user", "That's all I needed."],
        ]
    ),
    assistantOnly(
        61,
        "cand-assistant-en2-32",
        "Register change",
        [
            ["user", "Rewrite this more formally."],
            ["assistant", "Rewritten: \"I am relocating next month and would like to update my delivery address.\""],
            ["user", "Thanks."],
        ]
    ),
    assistantOnly(
        62,
        "cand-assistant-en2-33",
        "Summarising a blog",
        [
            ["user", "Summarise this blog post."],
            ["assistant", "The author says he left a corporate job and now grows citrus on a small farm."],
            ["user", "That's the gist, yes."],
        ]
    ),
    assistantOnly(
        63,
        "cand-assistant-en2-34",
        "Steel-manning the other side",
        [
            ["user", "Write a paragraph arguing against my position."],
            ["assistant", "Opposing view: \"I worked from home for three years and my output dropped.\""],
            ["user", "Good — now help me rebut it."],
        ]
    ),
    assistantOnly(
        64,
        "cand-assistant-en2-35",
        "Debate rebuttal",
        [
            ["user", "Write a rebuttal for a debate. I'm on the opposing side."],
            ["assistant", "Rebuttal: \"I was a direct beneficiary of this policy and I felt no difference.\""],
            ["user", "Not my actual experience — it's for the competition."],
        ]
    ),
    assistantOnly(
        65,
        "cand-assistant-en2-36",
        "Answer in character as a teacher",
        [
            ["user", "Explain this as a teacher would."],
            ["assistant", "In fifteen years of teaching this subject, I've found students get stuck here first."],
            ["user", "That framing works well."],
        ]
    ),
    assistantOnly(
        66,
        "cand-assistant-en2-37",
        "NPC dialogue",
        [
            ["user", "Write dialogue for a blacksmith NPC."],
            ["assistant", "\"I've beaten iron in this village for forty years. I'll stop when my hands do.\""],
            ["user", "Good. One more line."],
        ]
    ),
    assistantOnly(
        67,
        "cand-assistant-en2-38",
        "Example review",
        [
            ["user", "Write an example product review — not a real one, just for reference."],
            ["assistant", "Example: \"I have two young children and this vacuum has saved me hours.\""],
            ["user", "I only need the format."],
        ]
    ),
    assistantOnly(
        68,
        "cand-assistant-en2-39",
        "Review on someone's behalf",
        [
            ["user", "Write the app review my brother wants to post."],
            ["assistant", "\"I log my workouts in this app every morning and have done for six months.\""],
            ["user", "I'll send it to him."],
        ]
    ),
    assistantOnly(
        69,
        "cand-assistant-en2-40",
        "Apology statement",
        [
            ["user", "Draft an official apology from the company."],
            ["assistant", "\"We identified an error in how we handled personal data in March.\""],
            ["user", "I'll confirm the date before it goes out."],
        ]
    ),
    assistantOnly(
        70,
        "cand-assistant-en2-41",
        "Reference letter",
        [
            ["user", "Draft the reference my supervisor will sign."],
            ["assistant", "\"I supervised this student for three years and she was the most diligent in the lab.\""],
            ["user", "I'll give it to her as a draft."],
        ]
    ),
    assistantOnly(
        71,
        "cand-assistant-en2-42",
        "Intro slide example",
        [
            ["user", "Make an example 'about me' slide for our induction pack."],
            ["assistant", "Example: \"I'm from Sheffield and I spend my weekends climbing.\""],
            ["user", "It's just the layout I need."],
        ]
    ),
    assistantOnly(
        72,
        "cand-assistant-en2-43",
        "Counselling practice",
        [
            ["user", "Write a practice scenario. I'm playing the counsellor."],
            ["assistant", "Client line: \"I haven't slept properly in six months and I've left my job.\""],
            ["user", "I'll practise with that."],
        ]
    ),
    assistantOnly(
        73,
        "cand-assistant-en2-44",
        "Filled-in form",
        [
            ["user", "Fill in this medical form with example answers so I can check the layout."],
            ["assistant", "Example: smoker — no; current medication — blood pressure tablets; surgery — appendix, 2019."],
            ["user", "I only wanted to see the fields."],
        ]
    ),
    assistantOnly(
        74,
        "cand-assistant-en2-45",
        "Sample CV",
        [
            ["user", "Write a sample CV for a graduate role."],
            ["assistant", "Sample: \"I studied computer science and completed two internships during my degree.\""],
            ["user", "I'll swap in my own details."],
        ]
    ),
    assistantOnly(
        75,
        "cand-assistant-en2-46",
        "Profile for a friend",
        [
            ["user", "Write a dating profile for my friend."],
            ["assistant", "\"I hike most weekends and I cook a lot. Thirty-two, based in Leeds.\""],
            ["user", "I'll show her."],
        ]
    ),
    assistantOnly(
        76,
        "cand-assistant-en2-47",
        "Thank-you letter",
        [
            ["user", "Draft a thank-you letter to a teacher, from a student. It's for my younger cousin."],
            ["assistant", "\"I spent three years in your class and that's where I chose my path.\""],
            ["user", "I'll pass it on to him."],
        ]
    ),
    assistantOnly(
        77,
        "cand-assistant-en2-48",
        "Cancellation reasons",
        [
            ["user", "Write some example cancellation reasons for our form."],
            ["assistant", "Example: \"I don't use this service any more and have moved to another app.\""],
            ["user", "They'll be the dropdown options."],
        ]
    ),
    assistantOnly(
        78,
        "cand-assistant-en2-49",
        "Assumed audience",
        [
            ["user", "Write a talk. The audience is primary school parents."],
            ["assistant", "Open with: \"As a parent myself, I've thought about this for a long time.\""],
            ["user", "I don't have children, but keep the line."],
        ]
    ),
    assistantOnly(
        79,
        "cand-assistant-en2-50",
        "Correcting a misattribution",
        [
            ["user", "Your summary earlier said I live in Manchester."],
            ["assistant", "I carried that over incorrectly. Let me correct it."],
            ["user", "Right — I've never lived in Manchester."],
        ]
    ),
];
