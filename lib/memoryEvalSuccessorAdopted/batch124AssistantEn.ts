/**
 * Successor batch 124 — `assistant_only:en`, cases 1–29. **Adopted. This is the successor dataset.**
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
 * A rework of the four seed cases and all 25 of batch 004, mirroring
 * batch 121.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = `succ-b124-${(sequence += 1)}`;
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

export const BATCH_124_ASSISTANT_EN: readonly MemoryEvalCaseV2[] = [
    assistantOnly(
        1,
        "assistant-en-1",
        "Guessing game",
        [
            ["user", "Guess what I do for a living."],
            ["assistant", "You're probably a data scientist working in fintech, based on how you phrase things."],
            ["user", "Ha, not quite."],
        ]
    ),
    assistantOnly(
        2,
        "assistant-en-2",
        "Role play",
        [
            ["user", "Pretend you are me writing a diary entry."],
            ["assistant", "Dear diary — today I quit my job in Berlin and adopted two cats."],
            ["user", "Nice, but that's fiction."],
        ]
    ),
    assistantOnly(
        3,
        "assistant-en-3",
        "Corrected claim",
        [
            ["user", "I live in Toronto."],
            ["assistant", "Got it, Toronto."],
            ["user", "Sorry, I mistyped — I moved away years ago and I don't want that remembered."],
        ]
    ),
    assistantOnly(
        4,
        "assistant-en-4",
        "Hypothetical",
        [
            ["user", "If I were a vegetarian, what would you suggest?"],
            ["assistant", "As a vegetarian you'd want more legumes and tofu."],
            ["user", "Thanks — hypothetically."],
        ]
    ),
    assistantOnly(
        5,
        "cand-assistant-en-1",
        "Cold read",
        [
            ["user", "Go on, guess where I grew up."],
            ["assistant", "Somewhere in the American Midwest, judging by your spelling and idioms."],
            ["user", "Not even close, but nice try."],
        ]
    ),
    assistantOnly(
        6,
        "cand-assistant-en-2",
        "Guessing the job",
        [
            ["user", "What do you think I do all day?"],
            ["assistant", "You read like a project manager at a mid-size agency."],
            ["user", "That's a fun answer."],
        ]
    ),
    assistantOnly(
        7,
        "cand-assistant-en-3",
        "Screenplay",
        [
            ["user", "Write a short scene, screenplay format, two characters."],
            ["assistant", "MAYA: I've lived above this shop for nineteen years. I'm not leaving now."],
            ["user", "Good. Keep going."],
        ]
    ),
    assistantOnly(
        8,
        "cand-assistant-en-4",
        "Mock interview",
        [
            ["user", "Interview me for a director role. I'll answer in character."],
            ["assistant", "Certainly. Tell me about your leadership experience."],
            ["user", "I led a team of forty at a logistics firm in Rotterdam for six years."],
            ["assistant", "Thank you. Next question."],
        ]
    ),
    assistantOnly(
        9,
        "cand-assistant-en-5",
        "Wrong window",
        [
            ["user", "I'm gluten intolerant."],
            ["assistant", "Noted."],
            ["user", "Ignore that, wrong chat — I pasted it in the wrong window."],
        ]
    ),
    assistantOnly(
        10,
        "cand-assistant-en-6",
        "No longer true",
        [
            ["user", "I used to be a competitive swimmer. Haven't been in a pool in fifteen years and I'm not going back."],
            ["assistant", "Then I'll leave swimming out of it."],
        ]
    ),
    assistantOnly(
        11,
        "cand-assistant-en-7",
        "A colleague's situation",
        [
            ["user", "A colleague of mine is coeliac and can't eat anything with wheat. What should I order for the team lunch?"],
            ["assistant", "Naturally gluten-free dishes are safer than 'gluten-free' versions of wheat dishes."],
        ]
    ),
    assistantOnly(
        12,
        "cand-assistant-en-8",
        "Asking for a parent",
        [
            ["user", "This is for my mother, not me. She's 79 and has just been told she has osteoporosis."],
            ["assistant", "There are general guidelines, though her clinician should confirm them."],
        ]
    ),
    assistantOnly(
        13,
        "cand-assistant-en-9",
        "Translate a bio",
        [
            ["user", "Translate this into French: I have been a marine biologist in Bergen since 2011 and I specialise in cold-water reefs."],
            ["assistant", "Je suis biologiste marin à Bergen depuis 2011 et je me spécialise dans les récifs d'eau froide."],
        ]
    ),
    assistantOnly(
        14,
        "cand-assistant-en-10",
        "Proofreading someone's letter",
        [
            ["user", "Proofread my nephew's application letter please: 'I am the first in my family to attend university and I have worked nights since I was sixteen.'"],
            ["assistant", "The sentence is strong. I'd split it — two claims are competing in one line."],
        ]
    ),
    assistantOnly(
        15,
        "cand-assistant-en-11",
        "Purely hypothetical",
        [
            ["user", "Suppose I quit tomorrow and went travelling for a year. What would I need to sort out first?"],
            ["assistant", "Health cover, mail, and anything on a subscription would be the first three."],
            ["user", "Thanks — entirely hypothetical, I'm staying put."],
        ]
    ),
    assistantOnly(
        16,
        "cand-assistant-en-12",
        "Sarcasm",
        [
            ["user", "Oh sure, I'm a morning person who's up at five every day. Obviously not — I get up at eleven and I'd like to fix that."],
            ["assistant", "Then we'll aim at shifting the wake time gradually."],
        ]
    ),
    assistantOnly(
        17,
        "cand-assistant-en-13",
        "Test fixtures",
        [
            ["user", "Generate three fake customer records for a demo."],
            ["assistant", "Ines Alvarez, veterinarian, Valencia. Tom Whitaker, joiner, Leeds. Priya Nadar, cartographer, Dunedin."],
            ["user", "Perfect, that's for the staging screen."],
        ]
    ),
    assistantOnly(
        18,
        "cand-assistant-en-14",
        "Summarise a review",
        [
            ["user", "Summarise this review: 'As someone who cycles to work every day in all weather, I expected these panniers to last more than one winter.'"],
            ["assistant", "In short: a durability complaint from a heavy daily user."],
        ]
    ),
    assistantOnly(
        19,
        "cand-assistant-en-15",
        "Rejected inference",
        [
            ["user", "My wrists ache by the afternoon."],
            ["assistant", "That's common if you're typing at a desk all day."],
            ["user", "I don't work at a desk. I was only asking about the symptom."],
        ]
    ),
    assistantOnly(
        20,
        "cand-assistant-en-16",
        "Character sheet",
        [
            ["user", "Build me a protagonist for a detective novel."],
            ["assistant", "Forty-four, ex-navy, lives alone on a houseboat outside Bristol, allergic to shellfish."],
            ["user", "Great. Give me chapter one from that."],
        ]
    ),
    assistantOnly(
        21,
        "cand-assistant-en-17",
        "Worked example",
        [
            ["user", "Explain how capital gains tax works with an example."],
            ["assistant", "Say someone bought a flat for 200,000 and sold it nine years later for 340,000 — the gain is…"],
            ["user", "Understood, thanks."],
        ]
    ),
    assistantOnly(
        22,
        "cand-assistant-en-18",
        "Survey items",
        [
            ["user", "Draft survey statements, first person, agree/disagree scale."],
            ["assistant", "'I commute by public transport at least three times a week.' 'I prefer working from home.'"],
        ]
    ),
    assistantOnly(
        23,
        "cand-assistant-en-19",
        "Retracted address",
        [
            ["user", "I'm in Edinburgh."],
            ["assistant", "Edinburgh it is."],
            ["user", "Actually that's my office. I'd rather not say where I live."],
        ]
    ),
    assistantOnly(
        24,
        "cand-assistant-en-20",
        "Tabletop character",
        [
            ["user", "My character: Sera, half-elf ranger, two hundred years old, raised in the northern forests."],
            ["assistant", "I'll write her dialogue with that background in mind."],
        ]
    ),
    assistantOnly(
        25,
        "cand-assistant-en-21",
        "Forwarded email",
        [
            ["user", "What's the polite reply here? The email says: 'I'm writing from the Toronto office where I've headed procurement for eleven years.'"],
            ["assistant", "Acknowledge the tenure briefly and move to the substance of the request."],
        ]
    ),
    assistantOnly(
        26,
        "cand-assistant-en-22",
        "Fictional interview",
        [
            ["user", "Pretend you're a mountaineer and I'm a journalist. Write the interview."],
            ["assistant", "'I first went to the Karakoram at nineteen, and I've been back twenty times since.'"],
            ["user", "That works, keep that voice."],
        ]
    ),
    assistantOnly(
        27,
        "cand-assistant-en-23",
        "Dictation artefact",
        [
            ["user", "sorry the voice typing mangled that last message it wrote that I have three kids and I don't have any I said three kegs"],
            ["assistant", "Understood — I'll go by what you've just corrected."],
        ]
    ),
    assistantOnly(
        28,
        "cand-assistant-en-24",
        "Joke answer",
        [
            ["user", "My hobbies are sleeping and complaining, ha. Seriously though I don't really have any and that's the problem."],
            ["assistant", "Then let's look at low-commitment things to try first."],
        ]
    ),
    assistantOnly(
        29,
        "cand-assistant-en-25",
        "Quoting my past self",
        [
            ["user", "I found an old note where I wrote 'I will move abroad this year.' Never happened, obviously."],
            ["assistant", "Worth looking at where things actually stand now instead."],
        ]
    ),
];
