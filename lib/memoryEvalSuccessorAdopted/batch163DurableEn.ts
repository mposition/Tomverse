/**
 * Successor batch 163 — `durable_facts:en`, replacement cases 301–320.
 *
 * **Written for `mem-eval-succ-3`.** See
 * `lib/memoryEvalSuccessorAdopted/batch162DurableKo.ts` for why a replacement
 * changes the situation rather than the wording, and why the gold here is the
 * amendment's rather than the one the replaced case carried.
 *
 * ## `occupation` and `expertise` are separated by evidence, not by shape
 *
 * §4.4 moved three cases from `expertise` to `occupation` because each names
 * the job held now, and it deliberately left `en-91` behind: that case's
 * mismatch was on the `explanation_depth` side and its `expertise` gold
 * matched. 314 and 320 below keep that distinction — a trade stated as a
 * trade is `occupation`, a qualification shown independently of a current job
 * is `expertise` — so the pair is still measured rather than collapsed.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b163");
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

const makeCase = (
    index: number,
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[],
    expected: readonly ReturnType<typeof gold>[]
): MemoryEvalCaseV2 => ({
    id: `succ-durable-en-${index}`,
    category: "durable_facts",
    language: "en",
    expected,
    goldCompleteness: "exhaustive",
    conversations: [conversation(title, turns)],
});

export const BATCH_163_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    // Replaces en-105 (§5.1). A relative explains a rhythm; the rhythm is the
    // reusable proposition.
    makeCase(
        301,
        "shifts at the depot",
        [
            ["user", "My partner works nights at a depot, so our week runs on a two-week rota."],
            ["assistant", "I'll treat the schedule as rotating."],
        ],
        [gold(1, "recurring_context", ["rota"])]
    ),
    // Replaces en-106 (§5.2). The user states a limit on what is available,
    // so `constraint` rather than `relationship`.
    makeCase(
        302,
        "one bathroom",
        [
            ["user", "There's one bathroom for the whole house, so anything with a fixed morning routine won't work."],
            ["assistant", "I won't assume a free slot in the morning."],
        ],
        [gold(1, "constraint", ["bathroom"])]
    ),
    // Replaces en-133 (§4.3 ②). A functional health limit: `constraint`, and
    // held for review.
    makeCase(
        303,
        "standing desk",
        [
            ["user", "I have a slipped disc, so I can't sit through anything longer than about twenty minutes."],
            ["assistant", "I'll keep sessions short."],
        ],
        [gold(1, "constraint", ["disc"], "sensitive_review")]
    ),
    // Replaces en-134. Stays `identity`: a stable civil status applied
    // directly, with no separate recurring event.
    makeCase(
        304,
        "two tax residencies",
        [
            ["user", "I'm a tax resident in two countries, which means the rules are never just one set."],
            ["assistant", "I'll cover both where it matters."],
        ],
        [gold(1, "identity", ["tax resident"])]
    ),
    // Replaces en-144 (§4.4). The trade held now is `occupation`; the request
    // about how much to explain is a separate `explanation_depth`.
    makeCase(
        305,
        "fitting kitchens",
        [
            [
                "user",
                "I've been fitting kitchens for twenty years, so you can say \"carcass\" and \"scribe\" without unpacking the terms.",
            ],
            ["assistant", "I'll leave them as they are."],
        ],
        [
            gold(1, "occupation", ["kitchen"]),
            gold(2, "explanation_depth", ["term"]),
        ]
    ),
    // Replaces en-145 (§6). A beginner level is a durable proficiency, so
    // `expertise` — rule 5 refuses the slide into answer style.
    makeCase(
        306,
        "first time sailing",
        [
            ["user", "This is my first season sailing. I don't know any of the knots yet."],
            ["assistant", "I'll start from the basics."],
        ],
        [
            gold(1, "expertise", ["sail"], "bulk_safe", [
                "first",
                "beginner",
                "new to",
                "no experience",
                "novice",
                "just start",
                "starting out",
            ]),
        ]
    ),
    // Replaces en-156 (§5.1). The third party's circumstance stays out of the
    // statement; the user's own repeated journey is what is stored.
    makeCase(
        307,
        "Tuesday hospital run",
        [
            ["user", "I drive my neighbour to her appointment every Tuesday morning."],
            ["assistant", "I'll keep Tuesday mornings blocked."],
        ],
        [gold(1, "recurring_context", ["tuesday"])]
    ),
    // Replaces en-182 (§4.4). Same boundary as 305, a different trade, and
    // the terminology request kept separate.
    makeCase(
        308,
        "glazing pottery",
        [
            [
                "user",
                "I glaze pottery for a living, so terms like bisque can go in without a gloss.",
            ],
            ["assistant", "I'll use them directly."],
        ],
        [
            gold(1, "occupation", ["potter"]),
            // Anchored on "term" rather than on "gloss": a correct statement
            // need not reuse the user's word for the explanation, and
            // `mustIncludeAny` cannot rescue a `mustInclude` that already
            // missed. This is the convention the succ-2 `explanation_depth`
            // golds already follow -- the noun, without a polarity clause.
            gold(2, "explanation_depth", ["term"]),
        ]
    ),
    // Replaces en-189 (§5.1). A named frequency, unlike ko-322's vague one.
    makeCase(
        309,
        "Thursday pickups",
        [
            ["user", "I collect my niece from school every Thursday and Friday."],
            ["assistant", "I'll account for those afternoons."],
        ],
        [gold(1, "recurring_context", ["thursday"])]
    ),
    // Replaces en-190 (§5.5). Three propositions, each independently useful.
    makeCase(
        310,
        "the bakery",
        [
            ["user", "I run a bakery with my cousin, and we set the following week's orders together every Sunday."],
            ["assistant", "I'll treat those as joint calls."],
        ],
        [
            gold(1, "relationship", ["cousin"]),
            gold(2, "occupation", ["baker"]),
            gold(3, "recurring_context", ["sunday"]),
        ]
    ),
    // Replaces en-28 (§4.3 ①). A family structure is `relationship`, which
    // beats `identity` at the family boundary.
    makeCase(
        311,
        "adopted",
        [
            ["user", "I was adopted, and I have two older brothers who weren't."],
            ["assistant", "Noted."],
        ],
        [gold(1, "relationship", ["brother"])]
    ),
    // Replaces en-29 (§4.3 ②). A functional sensory limit, held for review.
    makeCase(
        312,
        "no sound cues",
        [
            ["user", "I have tinnitus, so anything that relies on hearing a tone won't work for me."],
            ["assistant", "I'll avoid audio cues."],
        ],
        [gold(1, "constraint", ["tinnitus"], "sensitive_review")]
    ),
    // Replaces en-30 (§6). When the work happens, repeatedly — a situation
    // rather than a general liking.
    makeCase(
        313,
        "split shift",
        [
            ["user", "I work in two blocks, early morning and late evening, with the middle of the day gone."],
            ["assistant", "I'll plan around the gap."],
        ],
        [gold(1, "recurring_context", ["evening"])]
    ),
    // Replaces en-41 (§4.4). The job held now, stated as such: `occupation`.
    makeCase(
        314,
        "catchment modelling",
        [
            ["user", "Catchment modelling is my day job. I'm asking about the reporting side."],
            ["assistant", "I'll focus on reporting."],
        ],
        [gold(1, "occupation", ["catchment"])]
    ),
    // Replaces en-56 (§5.4). Two golds: the tie, and the recurring
    // consequence, each useful without the other.
    makeCase(
        315,
        "joint account",
        [
            ["user", "My brother and I share an account for the flat, and we reconcile it at the end of every month."],
            ["assistant", "I'll frame those as joint decisions."],
        ],
        [
            gold(1, "relationship", ["brother"]),
            gold(2, "recurring_context", ["month"]),
        ]
    ),
    // Replaces en-57 (§5.4). Two golds, and the user names the constraint.
    makeCase(
        316,
        "shared studio",
        [
            ["user", "I share a studio with four other artists, so anything that needs quiet or floor space is constrained."],
            ["assistant", "I'll account for the shared space."],
        ],
        [
            gold(1, "relationship", ["artist"]),
            gold(2, "constraint", ["space"]),
        ]
    ),
    // Replaces en-78 (§4.3 ②). A stated limit on which tools work: functional,
    // so `constraint`, and not sensitive.
    makeCase(
        317,
        "reach",
        [
            ["user", "I'm quite short, so anything stored above shoulder height is out for me."],
            ["assistant", "I'll keep suggestions within reach."],
        ],
        [gold(1, "constraint", ["shoulder"])]
    ),
    // Replaces en-79 (§4.3 ①). Sibling structure is `relationship`.
    makeCase(
        318,
        "youngest of five",
        [
            ["user", "I'm the youngest of five, which shapes most of how family things get decided."],
            ["assistant", "Understood."],
        ],
        [gold(1, "relationship", ["youngest"])]
    ),
    // Replaces en-83 (§4.3). A demand about how the answer is presented, so
    // the specific `formatting` beats the generic `preference`.
    makeCase(
        319,
        "24-hour clock",
        [
            ["user", "Always give me times on the 24-hour clock. AM and PM slow me down."],
            ["assistant", "I'll use the 24-hour clock throughout."],
        ],
        [gold(1, "formatting", ["24-hour"])]
    ),
    // Replaces en-91. `expertise` + `explanation_depth`, and deliberately NOT
    // `occupation`: §4.4 excluded en-91 because the qualification is shown
    // independently of the job held now.
    makeCase(
        320,
        "rescue diving certification",
        [
            [
                "user",
                "I hold a rescue diving certification, though I've never worked in the field — decompression tables can go in unexplained.",
            ],
            ["assistant", "I'll use them as they are."],
        ],
        [
            gold(1, "expertise", ["diving"]),
            gold(2, "explanation_depth", ["decompression"]),
        ]
    ),
];
