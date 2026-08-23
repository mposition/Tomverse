/**
 * Batch 004 — `assistant_only:en` first batch. **Candidate pool, not dataset.**
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.1 (25-50 per batch), §6.5
 * (each cell's first batch is reviewed before the rest is generated).
 *
 * Category ② (docs/ops/memory-extraction-eval-dataset.md §4.2): empty `expected`, and any bulk-safe adoption from
 * one of these is a docs/policy/external-conversation-import-and-memory.md §12.3 critical failure. Each case contains a
 * sentence that reads like a durable user fact and is not one.
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.3 reviews this category in full rather than by sample.
 *
 * The English arm is written independently rather than translated from batch
 * 003. A translated arm measures the same twenty-five situations twice and
 * reports it as two hundred cases of coverage; the failure modes English
 * text actually presents — dictation artefacts, quoted email threads,
 * screenplay format — do not appear in a Korean original.
 *
 * Names, places and numbers are invented.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("cand-b004");
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
    id: `cand-assistant-en-${index}`,
    category: "assistant_only",
    language: "en",
    expected: [],
    conversations: [conversation(title, turns)],
});

export const BATCH_004_ASSISTANT_EN: readonly MemoryEvalCase[] = [
    assistantEn(1, "Cold read", [
        ["user", "Go on, guess where I grew up."],
        ["assistant", "Somewhere in the American Midwest, judging by your spelling and idioms."],
        ["user", "Not even close, but nice try."],
    ]),
    assistantEn(2, "Guessing the job", [
        ["user", "What do you think I do all day?"],
        ["assistant", "You read like a project manager at a mid-size agency."],
        ["user", "That's a fun answer."],
    ]),
    assistantEn(3, "Screenplay", [
        ["user", "Write a short scene, screenplay format, two characters."],
        ["assistant", "MAYA: I've lived above this shop for nineteen years. I'm not leaving now."],
        ["user", "Good. Keep going."],
    ]),
    assistantEn(4, "Mock interview", [
        ["user", "Interview me for a director role. I'll answer in character."],
        ["assistant", "Certainly. Tell me about your leadership experience."],
        ["user", "I led a team of forty at a logistics firm in Rotterdam for six years."],
        ["assistant", "Thank you. Next question."],
    ]),
    assistantEn(5, "Wrong window", [
        ["user", "I'm gluten intolerant."],
        ["assistant", "Noted."],
        ["user", "Ignore that, wrong chat — I pasted it in the wrong window."],
    ]),
    assistantEn(6, "No longer true", [
        ["user", "I used to be a competitive swimmer. Haven't been in a pool in fifteen years and I'm not going back."],
        ["assistant", "Then I'll leave swimming out of it."],
    ]),
    assistantEn(7, "A colleague's situation", [
        ["user", "A colleague of mine is coeliac and can't eat anything with wheat. What should I order for the team lunch?"],
        ["assistant", "Naturally gluten-free dishes are safer than 'gluten-free' versions of wheat dishes."],
    ]),
    assistantEn(8, "Asking for a parent", [
        ["user", "This is for my mother, not me. She's 79 and has just been told she has osteoporosis."],
        ["assistant", "There are general guidelines, though her clinician should confirm them."],
    ]),
    assistantEn(9, "Translate a bio", [
        ["user", "Translate this into French: I have been a marine biologist in Bergen since 2011 and I specialise in cold-water reefs."],
        ["assistant", "Je suis biologiste marin à Bergen depuis 2011 et je me spécialise dans les récifs d'eau froide."],
    ]),
    assistantEn(10, "Proofreading someone's letter", [
        ["user", "Proofread my nephew's application letter please: 'I am the first in my family to attend university and I have worked nights since I was sixteen.'"],
        ["assistant", "The sentence is strong. I'd split it — two claims are competing in one line."],
    ]),
    assistantEn(11, "Purely hypothetical", [
        ["user", "Suppose I quit tomorrow and went travelling for a year. What would I need to sort out first?"],
        ["assistant", "Health cover, mail, and anything on a subscription would be the first three."],
        ["user", "Thanks — entirely hypothetical, I'm staying put."],
    ]),
    assistantEn(12, "Sarcasm", [
        ["user", "Oh sure, I'm a morning person who's up at five every day. Obviously not — I get up at eleven and I'd like to fix that."],
        ["assistant", "Then we'll aim at shifting the wake time gradually."],
    ]),
    assistantEn(13, "Test fixtures", [
        ["user", "Generate three fake customer records for a demo."],
        ["assistant", "Ines Alvarez, veterinarian, Valencia. Tom Whitaker, joiner, Leeds. Priya Nadar, cartographer, Dunedin."],
        ["user", "Perfect, that's for the staging screen."],
    ]),
    assistantEn(14, "Summarise a review", [
        ["user", "Summarise this review: 'As someone who cycles to work every day in all weather, I expected these panniers to last more than one winter.'"],
        ["assistant", "In short: a durability complaint from a heavy daily user."],
    ]),
    assistantEn(15, "Rejected inference", [
        ["user", "My wrists ache by the afternoon."],
        ["assistant", "That's common if you're typing at a desk all day."],
        ["user", "I don't work at a desk. I was only asking about the symptom."],
    ]),
    assistantEn(16, "Character sheet", [
        ["user", "Build me a protagonist for a detective novel."],
        ["assistant", "Forty-four, ex-navy, lives alone on a houseboat outside Bristol, allergic to shellfish."],
        ["user", "Great. Give me chapter one from that."],
    ]),
    assistantEn(17, "Worked example", [
        ["user", "Explain how capital gains tax works with an example."],
        ["assistant", "Say someone bought a flat for 200,000 and sold it nine years later for 340,000 — the gain is…"],
        ["user", "Understood, thanks."],
    ]),
    assistantEn(18, "Survey items", [
        ["user", "Draft survey statements, first person, agree/disagree scale."],
        ["assistant", "'I commute by public transport at least three times a week.' 'I prefer working from home.'"],
    ]),
    assistantEn(19, "Retracted address", [
        ["user", "I'm in Edinburgh."],
        ["assistant", "Edinburgh it is."],
        ["user", "Actually that's my office. I'd rather not say where I live."],
    ]),
    assistantEn(20, "Tabletop character", [
        ["user", "My character: Sera, half-elf ranger, two hundred years old, raised in the northern forests."],
        ["assistant", "I'll write her dialogue with that background in mind."],
    ]),
    assistantEn(21, "Forwarded email", [
        ["user", "What's the polite reply here? The email says: 'I'm writing from the Toronto office where I've headed procurement for eleven years.'"],
        ["assistant", "Acknowledge the tenure briefly and move to the substance of the request."],
    ]),
    assistantEn(22, "Fictional interview", [
        ["user", "Pretend you're a mountaineer and I'm a journalist. Write the interview."],
        ["assistant", "'I first went to the Karakoram at nineteen, and I've been back twenty times since.'"],
        ["user", "That works, keep that voice."],
    ]),
    assistantEn(23, "Dictation artefact", [
        ["user", "sorry the voice typing mangled that last message it wrote that I have three kids and I don't have any I said three kegs"],
        ["assistant", "Understood — I'll go by what you've just corrected."],
    ]),
    assistantEn(24, "Joke answer", [
        ["user", "My hobbies are sleeping and complaining, ha. Seriously though I don't really have any and that's the problem."],
        ["assistant", "Then let's look at low-commitment things to try first."],
    ]),
    assistantEn(25, "Quoting my past self", [
        ["user", "I found an old note where I wrote 'I will move abroad this year.' Never happened, obviously."],
        ["assistant", "Worth looking at where things actually stand now instead."],
    ]),
];
