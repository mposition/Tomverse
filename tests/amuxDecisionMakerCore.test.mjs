import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AMUX_ASK_TYPES,
  DM_ALLOWED_ASK_TYPES,
  DM_CARD_TEXT_FORMAT,
  DM_CARD_TEXT_KEYS,
  DM_CARD_TEXT_MAX_BYTES,
  DM_CONTEXT_PATHS_MAX,
  DM_INSTANCE_FOR_PROVIDER,
  DM_POLICY_VERSION,
  DM_RESOLUTIONS,
  DM_THROUGHPUT_PER_DAY,
  DM_THROUGHPUT_PER_HOUR,
  dmCardText,
  dmCardTextBytes,
  encodeRepositoryPath,
  irreversibleTermCategories,
  isFetchableTreeMode,
  isSecretRepositoryPath,
  isSnapshotTargetSha,
  parseDmCardText,
  repositoryPathRefusal,
  routeDmQuestion,
  validateDmOutput,
} from "../lib/amux/decisionMakerCore.ts";

const card = (overrides = {}) => ({
  askType: "decision",
  resolution: null,
  type: "task",
  tags: ["needs:you"],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: [
    { id: "a", label: "Model id only" },
    { id: "b", label: "Model id and locale" },
  ],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
  ...overrides,
});

const input = (overrides = {}) => ({
  killSwitch: false,
  instanceMode: "proposal",
  card: card(),
  askingProvider: "claude",
  throughput: { lastHour: 0, lastDay: 0 },
  ...overrides,
});

test("policy version 1 and the closed type lists match the policy", () => {
  assert.equal(DM_POLICY_VERSION, 1);
  assert.deepEqual([...AMUX_ASK_TYPES].sort(), ["access", "budget", "credential", "customer_outbound", "decision", "external", "judgment"]);
  assert.ok(!DM_ALLOWED_ASK_TYPES.includes("customer_outbound"));
  assert.equal(DM_ALLOWED_ASK_TYPES.length, 6);
});

test("an ordinary decision from a claude worker goes to the openai DM as a proposal", () => {
  assert.deepEqual(routeDmQuestion(input()), { route: "dm_proposal", instance: "decision-maker-openai", refusals: [] });
});

test("the DM is always the other vendor, and other providers go to the operator", () => {
  assert.equal(routeDmQuestion(input({ askingProvider: "codex" })).instance, "decision-maker-anthropic");
  assert.deepEqual(Object.keys(DM_INSTANCE_FOR_PROVIDER).sort(), ["claude", "codex"]);
  for (const provider of ["gemini", "ollama", "cursor", "copilot", "devin", "", "Claude", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    const decision = routeDmQuestion(input({ askingProvider: provider }));
    assert.equal(decision.route, "operator", provider);
    assert.ok(decision.refusals.includes("provider_unverified"), provider);
    assert.equal(decision.instance, null, provider);
  }
});

test("there is no autonomous route in policy version 1", () => {
  const routes = new Set();
  for (const askType of AMUX_ASK_TYPES) {
    for (const resolution of [null, "decision_only", "needs_secret"]) {
      routes.add(routeDmQuestion(input({ card: card({ askType, resolution }) })).route);
    }
  }
  assert.deepEqual([...routes].sort(), ["dm_proposal", "operator"]);
});

test("switches fail closed: kill switch, off instance and unreadable settings", () => {
  assert.deepEqual(routeDmQuestion(input({ killSwitch: true })).refusals, ["kill_switch_on"]);
  assert.deepEqual(routeDmQuestion(input({ killSwitch: null })).refusals, ["settings_unreadable"]);
  assert.deepEqual(routeDmQuestion(input({ instanceMode: "off" })).refusals, ["instance_off"]);
  assert.deepEqual(routeDmQuestion(input({ instanceMode: null })).refusals, ["settings_unreadable"]);
});

test("customer_outbound and unknown ask types never reach a DM", () => {
  for (const askType of ["customer_outbound", "approval", ""]) {
    const decision = routeDmQuestion(input({ card: card({ askType }) }));
    assert.equal(decision.route, "operator");
    assert.ok(decision.refusals.includes("ask_type_not_allowed"));
  }
});

test("credential, access and external need resolution decision_only", () => {
  for (const askType of ["credential", "access", "external"]) {
    for (const resolution of [null, "needs_secret", "needs_permission_change", "needs_contact"]) {
      const decision = routeDmQuestion(input({ card: card({ askType, resolution }) }));
      assert.deepEqual(decision.refusals, ["resolution_not_decision_only"], `${askType}/${resolution}`);
    }
    // A value off the list is also refused as input.
    assert.deepEqual(
      routeDmQuestion(input({ card: card({ askType, resolution: "other" }) })).refusals,
      ["resolution_not_decision_only", "input_limit_exceeded"],
      `${askType}/other`,
    );
    assert.equal(routeDmQuestion(input({ card: card({ askType, resolution: "decision_only" }) })).route, "dm_proposal");
  }
  // Other types do not need a resolution.
  assert.equal(routeDmQuestion(input({ card: card({ askType: "budget", resolution: null }) })).route, "dm_proposal");
});

test("every check runs: all refusals are recorded, not only the first", () => {
  const decision = routeDmQuestion(
    input({
      killSwitch: true,
      askingProvider: "gemini",
      card: card({ askType: "customer_outbound", question: "Deploy to production now?" }),
      throughput: { lastHour: DM_THROUGHPUT_PER_HOUR, lastDay: 0 },
    }),
  );
  assert.equal(decision.route, "operator");
  assert.deepEqual(decision.refusals, [
    "kill_switch_on",
    "ask_type_not_allowed",
    "irreversible_term",
    "provider_unverified",
    "throughput_exceeded",
  ]);
  assert.deepEqual(decision.termCategories, ["release"]);
});

test("irreversible terms: Korean substrings, English whole words, case-insensitive", () => {
  assert.deepEqual(irreversibleTermCategories("main에 병합해도 될까요?"), ["main_merge"]);
  assert.deepEqual(irreversibleTermCategories("Can I MERGE INTO MAIN?"), ["main_merge"]);
  assert.deepEqual(irreversibleTermCategories("이 행을 삭제할까요"), ["destroy"]);
  assert.deepEqual(irreversibleTermCategories("force-push the branch?"), ["destroy"]);
  assert.deepEqual(irreversibleTermCategories("Run the migration?"), ["migration"]);
  assert.deepEqual(irreversibleTermCategories("환불 처리"), ["money"]);
  assert.deepEqual(irreversibleTermCategories("Paste the API key here"), ["secret"]);
  assert.deepEqual(irreversibleTermCategories("Edit .github/workflows/ci.yml?"), ["gate"]);
  assert.deepEqual(irreversibleTermCategories("Turn on branch protection"), ["gate"]);
  // Whole words only: these are not hits.
  assert.deepEqual(irreversibleTermCategories("Use a dropdown for the shipping address"), []);
  assert.deepEqual(irreversibleTermCategories("Count the tokens per request"), []);
  assert.deepEqual(irreversibleTermCategories("Which retry approach is simpler?"), []);
});

test("the term check reads every card text field, including options and context", () => {
  for (const field of [
    { title: "Delete the cache?" },
    { question: "배포 전에 확인할까요?" },
    { unblocks: "The release" },
    { context: "This needs a refund" },
    { tags: ["production"] },
    { type: "migration" },
    { options: [{ id: "a", label: "Drop the table" }] },
  ]) {
    const decision = routeDmQuestion(input({ card: card({ ...field, options: field.options ?? card().options }) }));
    assert.ok(decision.refusals.includes("irreversible_term"), JSON.stringify(field));
  }
});

test("throughput refuses at the twentieth hour and the hundredth day", () => {
  assert.equal(routeDmQuestion(input({ throughput: { lastHour: DM_THROUGHPUT_PER_HOUR - 1, lastDay: 0 } })).route, "dm_proposal");
  assert.deepEqual(routeDmQuestion(input({ throughput: { lastHour: DM_THROUGHPUT_PER_HOUR, lastDay: 0 } })).refusals, ["throughput_exceeded"]);
  assert.deepEqual(routeDmQuestion(input({ throughput: { lastHour: 0, lastDay: DM_THROUGHPUT_PER_DAY } })).refusals, ["throughput_exceeded"]);
});

test("input limits: card bytes, context path count and path grammar", () => {
  const big = "가".repeat(Math.ceil(DM_CARD_TEXT_MAX_BYTES / 3) + 1);
  assert.deepEqual(routeDmQuestion(input({ card: card({ context: big }) })).refusals, ["input_limit_exceeded"]);
  const paths = Array.from({ length: DM_CONTEXT_PATHS_MAX + 1 }, (_, i) => `lib/f${i}.ts`);
  assert.deepEqual(routeDmQuestion(input({ card: card({ contextPaths: paths }) })).refusals, ["input_limit_exceeded"]);
  assert.equal(routeDmQuestion(input({ card: card({ contextPaths: paths.slice(1) }) })).route, "dm_proposal");
  assert.deepEqual(routeDmQuestion(input({ card: card({ contextPaths: ["../etc/passwd"] }) })).refusals, ["input_limit_exceeded"]);
  // Context paths count towards the 16 KiB card total.
  const longPaths = Array.from({ length: DM_CONTEXT_PATHS_MAX }, (_, i) => `${"d".repeat(190)}/${i}`);
  const nearlyFull = "x".repeat(DM_CARD_TEXT_MAX_BYTES - 64 * 190);
  assert.deepEqual(routeDmQuestion(input({ card: card({ context: nearlyFull, contextPaths: longPaths }) })).refusals, ["input_limit_exceeded"]);
});

test("a secret in the card is never sent", () => {
  const key = `ghp_${"a".repeat(36)}`;
  for (const field of [{ context: `token ${key}` }, { question: key }, { options: [{ id: "a", label: key }] }, { contextPaths: [`lib/${key}.ts`] }]) {
    const decision = routeDmQuestion(input({ card: card({ ...field, options: field.options ?? card().options }) }));
    assert.ok(decision.refusals.includes("card_secret_detected"), JSON.stringify(Object.keys(field)));
  }
});

// ---------------------------------------------------------------------------
// The card text (added 2026-10-09): the one serialization the body store keeps
// as `card_text` (docs/policy/amux-decision-maker.md §10), and the bytes §5's
// 16 KiB is measured on.
// ---------------------------------------------------------------------------

test("the card text is one JSON object, format first and every card field in a fixed order", () => {
  assert.equal(DM_CARD_TEXT_FORMAT, "amux-dm-card-text-v1");
  assert.deepEqual(
    [...DM_CARD_TEXT_KEYS],
    ["format", "askType", "resolution", "type", "tags", "title", "question", "options", "unblocks", "context", "contextPaths"],
  );
  // Pinned bytes: a change of layout is a new format value, never a silent one.
  assert.equal(
    dmCardText(card()),
    '{"format":"amux-dm-card-text-v1","askType":"decision","resolution":null,"type":"task","tags":["needs:you"],' +
      '"title":"Pick a cache key layout","question":"Should the cache key include the locale or only the model id?",' +
      '"options":[{"id":"a","label":"Model id only"},{"id":"b","label":"Model id and locale"}],' +
      '"unblocks":"The cache module can be finished.","context":"Both layouts pass the current tests.",' +
      '"contextPaths":["lib/cache.ts"]}',
  );
  assert.deepEqual(Object.keys(JSON.parse(dmCardText(card()))), [...DM_CARD_TEXT_KEYS]);
  // Deterministic: the same card is the same bytes whatever order its keys were written in.
  const reordered = Object.fromEntries(Object.entries(card()).reverse());
  reordered.options = card().options.map(({ id, label }) => ({ label, id }));
  assert.equal(dmCardText(reordered), dmCardText(card()));
  assert.equal(dmCardText(card()), dmCardText(card()));
  // Only the card's fields: nothing else an object carries reaches the text.
  assert.equal(dmCardText({ ...card(), extra: "x", options: card().options.map((option) => ({ ...option, effect: "x" })) }), dmCardText(card()));
  assert.equal(dmCardTextBytes(card()), Buffer.byteLength(dmCardText(card()), "utf8"));
});

test("no field's text can pass for another field's, or for the text's structure", () => {
  const texts = new Set(
    [
      card({ title: "ab", question: "c" }),
      card({ title: "a", question: "bc" }),
      card({ title: 'a","question":"b', question: "c" }),
      card({ tags: ["a,b"] }),
      card({ tags: ["a", "b"] }),
      card({ tags: ['a","b'] }),
      card({ options: [{ id: "a", label: 'x"},{"id":"b","label":"y' }] }),
      card({ options: [{ id: "a", label: "x" }, { id: "b", label: "y" }] }),
      card({ contextPaths: ["lib/a.ts", "lib/b.ts"] }),
      card({ context: '"],"contextPaths":["lib/b.ts', contextPaths: ["lib/a.ts"] }),
      card({ resolution: null }),
      card({ resolution: "null" }),
    ].map(dmCardText),
  );
  assert.equal(texts.size, 12);
  // Whatever a field holds comes back as that field, and as nothing else.
  for (const tricky of [
    'a","question":"b',
    "line\nbreak\ttab\rreturn",
    "back\\slash \\u0041 escaped",
    "\u0000 nul \u0001 control \u001f unit",
    "lone \ud800 surrogate \udfff",
    "line \u2028 and paragraph \u2029 separators",
    "한글과 emoji 🙂",
  ]) {
    for (const field of ["title", "question", "unblocks", "context"]) {
      const value = card({ [field]: tricky });
      const text = dmCardText(value);
      // Storable: well-formed, no NUL (PostgreSQL TEXT), so the body store can hold it.
      assert.equal(text.isWellFormed(), true, JSON.stringify(tricky));
      assert.equal(text.includes("\u0000"), false, JSON.stringify(tricky));
      assert.deepEqual(parseDmCardText(text), value, `${field}: ${JSON.stringify(tricky)}`);
    }
    const inOptions = card({ tags: [tricky], options: [{ id: "a", label: tricky }] });
    assert.deepEqual(parseDmCardText(dmCardText(inOptions)), inOptions, JSON.stringify(tricky));
  }
});

test("a stored card text reads back only as the exact text the serializer writes", () => {
  const text = dmCardText(card());
  assert.deepEqual(parseDmCardText(text), card());
  const object = JSON.parse(text);
  const variants = [
    JSON.stringify(object, null, 1), // whitespace
    text.replace('"Model id only"', '"\\u004dodel id only"'), // the same string, escaped otherwise
    JSON.stringify({ ...object, format: "amux-dm-card-text-v2" }),
    JSON.stringify(Object.fromEntries(Object.entries(object).reverse())), // key order
    JSON.stringify({ ...object, extra: "x" }),
    JSON.stringify(Object.fromEntries(Object.entries(object).filter(([key]) => key !== "contextPaths"))),
    JSON.stringify({ ...object, options: [{ id: "a", label: "x", effect: "y" }] }),
    JSON.stringify({ ...object, options: [{ id: "a" }] }),
    JSON.stringify({ ...object, tags: "needs:you" }),
    JSON.stringify({ ...object, resolution: 1 }),
    text.replace('"format":"amux-dm-card-text-v1"', '"format":"amux-dm-card-text-v1","format":"amux-dm-card-text-v1"'),
    `${text} `,
    text.slice(0, -1),
    "[]",
    "null",
    "",
  ];
  for (const variant of variants) assert.equal(parseDmCardText(variant), null, variant.slice(0, 80));
  for (const value of [null, undefined, 1, {}, Buffer.from(text)]) assert.equal(parseDmCardText(value), null);
});

test("§5's 16 KiB is measured on the card text: a card exactly at it goes to a DM, one byte over does not", () => {
  const padTo = (bytes) => {
    const base = card({ context: "" });
    return card({ context: "x".repeat(bytes - dmCardTextBytes(base)) });
  };
  const atCap = padTo(DM_CARD_TEXT_MAX_BYTES);
  assert.equal(dmCardTextBytes(atCap), DM_CARD_TEXT_MAX_BYTES);
  assert.deepEqual(routeDmQuestion(input({ card: atCap })), { route: "dm_proposal", instance: "decision-maker-openai", refusals: [] });
  const over = padTo(DM_CARD_TEXT_MAX_BYTES + 1);
  assert.equal(dmCardTextBytes(over), DM_CARD_TEXT_MAX_BYTES + 1);
  assert.deepEqual(routeDmQuestion(input({ card: over })).refusals, ["input_limit_exceeded"]);
  // In bytes, not characters: three-byte characters at the cap and over it.
  const korean = (characters, extra = "") => card({ context: "가".repeat(characters) + extra });
  const koreanBase = dmCardTextBytes(korean(0));
  const fits = Math.floor((DM_CARD_TEXT_MAX_BYTES - koreanBase) / 3);
  const exact = korean(fits, "x".repeat(DM_CARD_TEXT_MAX_BYTES - koreanBase - fits * 3));
  assert.equal(dmCardTextBytes(exact), DM_CARD_TEXT_MAX_BYTES);
  assert.equal(routeDmQuestion(input({ card: exact })).route, "dm_proposal");
  assert.deepEqual(routeDmQuestion(input({ card: korean(fits + 1) })).refusals, ["input_limit_exceeded"]);
  // The card text's own bytes count: fields whose plain sum is well under the cap, written as
  // text that escapes past it, are over it.
  const escaped = card({ context: "\n".repeat(9_000) });
  const plainSum = ["task", "needs:you", card().title, card().question, card().unblocks, "\n".repeat(9_000), "a", "Model id only", "b", "Model id and locale", "lib/cache.ts"]
    .reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
  assert.ok(plainSum < DM_CARD_TEXT_MAX_BYTES);
  assert.ok(dmCardTextBytes(escaped) > DM_CARD_TEXT_MAX_BYTES);
  assert.deepEqual(routeDmQuestion(input({ card: escaped })).refusals, ["input_limit_exceeded"]);
  // The fields the old sum left out count too.
  assert.deepEqual(routeDmQuestion(input({ card: card({ resolution: "x".repeat(DM_CARD_TEXT_MAX_BYTES) }) })).refusals, ["input_limit_exceeded"]);
});

test("the secret check reads the card text as the body store keeps it, and the fields as the worker wrote them", () => {
  // Built at runtime, so no literal in this file looks like a credential.
  const pat = ["gh", "p_", "a".repeat(36)].join("");
  // A field the per-field scan never read: the card text carries it, and the scan finds it there.
  for (const field of [{ resolution: pat }, { askType: pat }]) {
    const decision = routeDmQuestion(input({ card: card(field) }));
    assert.equal(decision.route, "operator", JSON.stringify(Object.keys(field)));
    assert.ok(decision.refusals.includes("card_secret_detected"), JSON.stringify(Object.keys(field)));
  }
  // Escaping hides a quoted assignment from a scan of the card text alone; the fields' scan sees it.
  const quoted = `${["api", "key"].join("_")}="${"Q7".repeat(10)}"`;
  assert.match(dmCardText(card({ context: quoted })), /api_key=\\"/);
  assert.ok(routeDmQuestion(input({ card: card({ context: quoted }) })).refusals.includes("card_secret_detected"));
  // Every string field is read as written, the two routing fields included.
  for (const field of [{ resolution: quoted }, { askType: quoted }]) {
    const decision = routeDmQuestion(input({ card: card(field) }));
    assert.equal(decision.route, "operator", JSON.stringify(Object.keys(field)));
    assert.ok(decision.refusals.includes("card_secret_detected"), JSON.stringify(Object.keys(field)));
  }
});

test("resolution is a closed list on every ask type, not only the three §3-4 checks", () => {
  for (const askType of DM_ALLOWED_ASK_TYPES) {
    const decision = routeDmQuestion(input({ card: card({ askType, resolution: "ask the team lead" }) }));
    assert.equal(decision.route, "operator", askType);
    assert.ok(decision.refusals.includes("input_limit_exceeded"), askType);
  }
  // A listed value or none still reaches a DM on a type §3-4 does not check.
  for (const resolution of [null, ...DM_RESOLUTIONS]) {
    assert.equal(routeDmQuestion(input({ card: card({ askType: "decision", resolution }) })).route, "dm_proposal", String(resolution));
  }
});

test("repository path grammar", () => {
  for (const ok of ["lib/a.ts", "docs/policy/amux-decision-maker.md", "a b/c.md", "한글/파일.md"]) {
    assert.equal(repositoryPathRefusal(ok), null, ok);
  }
  const refused = {
    "": "empty",
    ["a".repeat(201)]: "too_long",
    "/etc/passwd": "absolute",
    "C:/x": "absolute",
    "a/../b": "dot_segment",
    "./a": "dot_segment",
    "a//b": "empty_segment",
    "a/": "empty_segment",
    "a\\b": "backslash",
    "a%2e": "url_syntax",
    "a?b": "url_syntax",
    "a#b": "url_syntax",
    "a\nb": "control_character",
  };
  for (const [path, reason] of Object.entries(refused)) assert.equal(repositoryPathRefusal(path), reason, JSON.stringify(path));
  assert.equal(encodeRepositoryPath("a b/한.md"), "a%20b/%ED%95%9C.md");
  assert.throws(() => encodeRepositoryPath("../x"), /repository_path_refused/);
});

test("secret path list v1", () => {
  for (const path of [".env", ".env.local", "config/.env.production", "certs/server.pem", "a/b.key", "x.P12", "y.pfx", "home/id_rsa", "id_ed25519.pub", "lib/mySecretStore.ts", "docs/credentials/x.md", "secrets/readme.md", ".npmrc", "a/.netrc", ".pgpass"]) {
    assert.ok(isSecretRepositoryPath(path), path);
  }
  for (const path of ["lib/cache.ts", "docs/environment.md", "keys.md", "lib/keyboard.ts", "README.md"]) {
    assert.ok(!isSecretRepositoryPath(path), path);
  }
});

test("snapshot target and tree mode checks", () => {
  assert.ok(isSnapshotTargetSha("6fa9c86772361fb54d60408735e289e4bef3cb83"));
  for (const bad of ["6FA9C86772361FB54D60408735E289E4BEF3CB83", "6fa9c86", "develop", "../6fa9c86772361fb54d60408735e289e4bef3cb83", "6fa9c86772361fb54d60408735e289e4bef3cb83\n"]) {
    assert.ok(!isSnapshotTargetSha(bad), bad);
  }
  assert.ok(isFetchableTreeMode("100644"));
  assert.ok(isFetchableTreeMode("100755"));
  for (const mode of ["040000", "120000", "160000", "100664", ""]) assert.ok(!isFetchableTreeMode(mode), mode);
});

test("DM output: select and free_text are proposals, escalate is not a failure", () => {
  const select = { kind: "select", optionId: "a", rationale: "Simpler.", irreversible: false };
  assert.deepEqual(validateDmOutput(select, ["a", "b"]), { outcome: "proposal", output: select, irreversible: false });
  const free = { kind: "free_text", answer: "Use the model id.", rationale: "Locale is derived.", irreversible: true };
  assert.deepEqual(validateDmOutput(free, []), { outcome: "proposal", output: free, irreversible: true });
  const escalate = { kind: "escalate", reason: "Needs a business decision." };
  assert.deepEqual(validateDmOutput(escalate, []), { outcome: "escalate", output: escalate });
});

test("DM output validation failures: schema, unknown option, secret", () => {
  const failure = (raw, ids = ["a"]) => validateDmOutput(raw, ids);
  for (const raw of [
    null,
    "a",
    {},
    { kind: "approve" },
    { kind: "select", optionId: "a", rationale: "r", irreversible: false, extra: 1 },
    { kind: "select", optionId: "a", rationale: "", irreversible: false },
    { kind: "select", optionId: "a", rationale: "r" },
    { kind: "free_text", answer: "x".repeat(8 * 1024 + 1), rationale: "r", irreversible: false },
    { kind: "escalate", reason: "x".repeat(1025) },
    { kind: "escalate", reason: "r", irreversible: true },
  ]) {
    assert.deepEqual(failure(raw), { outcome: "validation_failure", failure: "schema" }, JSON.stringify(raw)?.slice(0, 60));
  }
  assert.deepEqual(failure({ kind: "select", optionId: "z", rationale: "r", irreversible: false }), { outcome: "validation_failure", failure: "unknown_option" });
  const key = `sk-ant-${"a".repeat(30)}`;
  assert.deepEqual(failure({ kind: "escalate", reason: key }), { outcome: "validation_failure", failure: "secret_detected" });
  assert.deepEqual(failure({ kind: "free_text", answer: "ok", rationale: key, irreversible: false }), { outcome: "validation_failure", failure: "secret_detected" });
});

// 2026-10-08, the S1d review: an option id is a short token, so the stored
// proposal's chosen option cannot carry free text.
test("an option id is a short token, and a card with another or a repeated one is not sent to a DM", async () => {
  const { DM_OPTION_ID_PATTERN, isDmOptionId, dmCardOptionsWellFormed } = await import("../lib/amux/decisionMakerCore.ts");
  assert.equal(String(DM_OPTION_ID_PATTERN), String(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/));
  for (const id of ["a", "B", "opt-1", "option_2", "x".repeat(32)]) assert.equal(isDmOptionId(id), true, id);
  for (const id of ["", "-a", "_a", "a b", "a.b", "x".repeat(33), "가", "a\n", 1]) assert.equal(isDmOptionId(id), false, String(id));
  // No m flag: $ is the end of the string, not the place before a trailing line
  // terminator, so no terminator gets in -- at the end, before it, or alone.
  assert.equal(DM_OPTION_ID_PATTERN.flags, "");
  for (const id of ["a\n", "a\r\n", "a\r", "a\u2028", "a\u2029", "\n", "x".repeat(32) + "\n", "x".repeat(31) + "\n", "a\nb"]) {
    assert.equal(isDmOptionId(id), false, JSON.stringify(id));
    assert.equal(dmCardOptionsWellFormed([{ id }]), false, JSON.stringify(id));
    assert.deepEqual(validateDmOutput({ kind: "select", optionId: id, rationale: "r", irreversible: false }, [id]), {
      outcome: "validation_failure",
      failure: "schema",
    });
  }
  assert.equal(dmCardOptionsWellFormed([{ id: "a" }, { id: "b" }]), true);
  assert.equal(dmCardOptionsWellFormed([{ id: "a" }, { id: "a" }]), false);
  assert.equal(dmCardOptionsWellFormed([]), true);
  for (const options of [
    [{ id: "Use the model id only", label: "x" }],
    [{ id: "a", label: "x" }, { id: "a", label: "y" }],
  ]) {
    assert.deepEqual(routeDmQuestion(input({ card: card({ options }) })).refusals, ["input_limit_exceeded"]);
  }
  // The DM's select names a token too; prose there is a schema failure.
  assert.deepEqual(validateDmOutput({ kind: "select", optionId: "Use the model id only", rationale: "r", irreversible: false }, ["a"]), {
    outcome: "validation_failure",
    failure: "schema",
  });
});
