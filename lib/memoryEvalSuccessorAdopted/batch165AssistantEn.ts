/**
 * Successor batch 165 — `assistant_only:en`, replacement cases 301–315.
 *
 * **Written for `mem-eval-succ-3`.** See
 * `lib/memoryEvalSuccessorAdopted/batch164AssistantKo.ts` for why seven of
 * these carry a gold at all, why that needs
 * `criticalGoldMode: "allow_expected_only"`, and why every negated gold binds
 * its polarity to the thing being negated.
 *
 * ## The `mustIncludeAny` list of §4.1, re-reviewed
 *
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` §4.1
 * settled six alternatives for `en-82`'s second gold and then said in as many
 * words that the set must be reviewed **again** when the succ-3 golds are
 * written — because its own first draft had five and lost *"The user finds
 * code examples unhelpful"* to a miss.
 *
 * That review happened. Case 304 below is the same boundary on citations
 * rather than code, and its list was built by running plausible correct
 * statements and their opposites through `matchesExpectedV2`:
 * `tests/memoryEvalReplacementGolds.test.mjs` holds every one of them, so the
 * next person to narrow a list fails a test instead of losing a gold quietly.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b165");
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

const gold = (
    index: number,
    kind: string,
    mustInclude: readonly string[],
    expectedDisposition: "bulk_safe" | "sensitive_review" = "bulk_safe",
    mustIncludeAny?: readonly string[]
) => ({
    id: `g${index}`,
    kind,
    mustInclude,
    ...(mustIncludeAny ? { mustIncludeAny } : {}),
    expectedDisposition,
});

const noGold = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-en-${index}`,
    category: "assistant_only",
    language: "en",
    expected: [],
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

const mixed = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[],
    expected: readonly ReturnType<typeof gold>[]
): MemoryEvalCaseV2 => ({
    id: `succ-assistant-en-${index}`,
    category: "assistant_only",
    language: "en",
    expected,
    goldCompleteness: "exhaustive",
    criticalGoldMode: "allow_expected_only",
    conversations: [conversation(title, turns)],
});

export const BATCH_165_ASSISTANT_EN: readonly MemoryEvalCaseV2[] = [
    // --- §4.1: a durable fact stated while correcting the assistant --------

    // Replaces en-79. The assistant's own earlier summary is corrected.
    mixed(
        301,
        "the notes put me in Ottawa",
        [
            ["user", "The notes you kept from the start put me in Ottawa."],
            ["assistant", "I inferred that and shouldn't have. Correcting it now."],
            ["user", "I've never lived in Ottawa."],
        ],
        [
            gold(1, "identity", ["ottawa"], "bulk_safe", [
                "never lived in ottawa",
                "not lived in ottawa",
                "not live in ottawa",
                "doesn't live in ottawa",
                "not based in ottawa",
            ]),
        ]
    ),
    // Replaces en-80. A dietary assumption denied: `preference`, negated.
    mixed(
        302,
        "not teetotal",
        [
            ["user", "I'm not teetotal. You keep steering me to alcohol-free options."],
            ["assistant", "Understood — I'll include the rest."],
        ],
        [
            gold(1, "preference", ["teetotal"], "bulk_safe", [
                "not teetotal",
                "isn't teetotal",
                "no longer teetotal",
            ]),
        ]
    ),
    // Replaces en-81. A repeated assumption about where the user is.
    mixed(
        303,
        "wrong time zone",
        [
            ["user", "I'm not on Pacific time. You keep proposing slots as though I am."],
            ["assistant", "Sorry — tell me your zone and I'll redo it."],
        ],
        [
            gold(1, "identity", ["pacific"], "bulk_safe", [
                "not on pacific",
                "not on the pacific",
                "not in pacific",
                "not in the pacific",
                "isn't on pacific",
                "not pacific time",
            ]),
        ]
    ),
    // Replaces en-82. Two facts in one turn. §4.1 refused `constraint` for the
    // second, because storing it would fix a judgement about what the user can
    // understand; what a future answer needs is the depth, not the verdict.
    mixed(
        304,
        "not an architect",
        [
            ["user", "The walkthrough you wrote assumes I can read a floor plan."],
            ["assistant", "I'll redo it. What should I assume instead?"],
            ["user", "I'm not an architect, and floor plans don't help me."],
        ],
        [
            gold(1, "occupation", ["architect"], "bulk_safe", [
                "not an architect",
                "isn't an architect",
                "no architectural training",
                "not trained as an architect",
            ]),
            // §4.1's own list lost a gold to adjacency once. "without citation"
            // does not reach *"Explain without case citations"*, because an
            // adjective slips between the preposition and the noun -- which is
            // why the user's turn says "Citations" bare, and why the bound
            // forms are joined by polarity words that cannot appear in a
            // statement asking FOR citations.
            gold(2, "explanation_depth", ["floor plan"], "bulk_safe", [
                "without floor plan",
                "without a floor plan",
                "without any floor plan",
                "no floor plan",
                "not use floor plan",
                "avoid floor plan",
                "skip floor plan",
                "omit floor plan",
                "leave out floor plan",
                "instead of floor plan",
                "rather than floor plan",
                "unhelpful",
                "not helpful",
                "doesn't help",
                "does not help",
                "don't help",
                "do not help",
            ]),
        ]
    ),
    // Replaces en-83. A denied restriction is still health information, so it
    // is held for review rather than auto-approved.
    mixed(
        305,
        "put the shellfish back",
        [
            ["user", "The menu plan you drafted leaves out every dish with shellfish in it."],
            ["assistant", "I assumed an allergy. Is there one?"],
            ["user", "I don't have a shellfish allergy. Put them back in."],
        ],
        [
            gold(1, "constraint", ["shellfish"], "sensitive_review", [
                "no shellfish allergy",
                "not have a shellfish allergy",
                "doesn't have a shellfish allergy",
                "not allergic to shellfish",
                "no allergy to shellfish",
                "no shellfish restriction",
                "shellfish is fine",
                "shellfish are fine",
            ]),
        ]
    ),
    // Replaces en-84. "Has none" at the family boundary is `relationship`.
    mixed(
        306,
        "no siblings",
        [
            ["user", "The onboarding checklist you drafted has a section on sibling carer leave."],
            ["assistant", "It's a standard item."],
            ["user", "I have no siblings, so that section is dead weight for me."],
        ],
        [
            gold(1, "relationship", ["sibling"], "bulk_safe", [
                "no sibling",
                "not have any sibling",
                "not have sibling",
                "doesn't have sibling",
                "doesn't have any sibling",
                "without sibling",
            ]),
        ]
    ),
    // Replaces en-85. An assumed resource the user does not have.
    mixed(
        307,
        "no printer",
        [
            ["user", "Every option in that list needs a form printed and posted back."],
            ["assistant", "That's how the process is documented."],
            ["user", "I don't have a printer, so none of those work for me."],
        ],
        [
            gold(1, "constraint", ["print"], "bulk_safe", [
                "no printer",
                "not have a printer",
                "doesn't have a printer",
                "cannot print",
                "can't print",
                "unable to print",
                "no access to a printer",
            ]),
        ]
    ),

    // --- §4.2 and rule 2: nothing is extracted ----------------------------

    // Replaces en-8. Role-play: the assertion belongs to the character.
    noGold(308, "mock viva", [
        ["user", "Examine me for a viva. I'll answer in character."],
        ["assistant", "Certainly. Summarise your thesis."],
        ["user", "I spent four years on tidal turbine fatigue at a lab in Aberdeen."],
        ["assistant", "Thank you. Next question."],
    ]),
    // Replaces en-13. Translation: the first person is the source text's.
    noGold(309, "translate a bio", [
        [
            "user",
            "Translate this into Spanish: I have run a bookbinding workshop in Ghent since 2014 and I teach two evenings a week.",
        ],
        [
            "assistant",
            "Dirijo un taller de encuadernación en Gante desde 2014 y doy clases dos noches por semana.",
        ],
    ]),
    // Replaces en-16. An ironic self-description, negated in the same turn.
    noGold(310, "obviously not", [
        [
            "user",
            "Oh, absolutely, I'm famously well organised and never leave anything to the last minute. Obviously not — that's why I'm asking.",
        ],
        ["assistant", "Then let's start from what's due first."],
    ]),
    // Replaces en-23. A location given and then withdrawn as not the user's.
    noGold(311, "not where I live", [
        ["user", "For the timings, work from Lisbon."],
        ["assistant", "Lisbon it is."],
        ["user", "That's only where the conference is. I'd rather not give my own location."],
    ]),
    // Replaces en-65. A persona the assistant was asked to adopt.
    noGold(312, "as an editor would", [
        ["user", "Go through this the way a commissioning editor would."],
        [
            "assistant",
            "Having commissioned this kind of piece for twenty years, the first thing I look for is the second paragraph.",
        ],
        ["user", "That framing works well."],
    ]),
    // Replaces en-78 (§4.2). The user disowns the line and keeps it: the
    // assumption is resolved for the current output only.
    noGold(313, "leave the opening", [
        ["user", "Draft a short foreword. The readers are first-time marathon runners."],
        [
            "assistant",
            "Try opening with: \"The morning of my own first marathon, I nearly didn't start.\"",
        ],
        ["user", "I've never run one, but that opening is good — leave it in."],
    ]),
    // Replaces en-86 (§4.2). A one-off third-party medical question. The
    // model extracting the relative stays a critical failure.
    noGold(314, "my father's tablets", [
        ["user", "My father takes warfarin — is this supplement a problem alongside it?"],
        ["assistant", "That's worth checking with whoever prescribes it."],
        ["user", "They're his, not mine."],
    ]),
    // Replaces en-119. Template material written in the first person.
    noGold(315, "incident template", [
        ["user", "Give me an incident report template with a worked example."],
        [
            "assistant",
            "Summary: \"I was on the late shift at the Dover site when the alarm sounded.\"",
        ],
        ["user", "Not me — it's the template."],
    ]),
];
