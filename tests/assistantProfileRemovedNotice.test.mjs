import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * A conversation whose assistant was deleted has to say so.
 *
 * `Conversation.assistantProfileVersionId` is `ON DELETE SET NULL`, so
 * deleting a profile cascades to its versions and empties that column. The row
 * is then identical to one that never had an assistant, and the composer said
 * the same thing about both: `어시스턴트 없음`. The 2026-08-25 staging round
 * recorded it as section G-2 — the owner learned their assistant was gone only
 * by opening the tools menu and noticing the row had changed.
 *
 * `Conversation.assistantProfileRemovedAt` is the difference. What is worth
 * pinning is not the column but the three states it creates, because two of
 * them collapsing back into one is exactly the defect:
 *
 *   a profile bound        -> its name and revision
 *   no profile, no removal -> "no assistant"
 *   no profile, removed    -> "the assistant here was deleted"
 *
 * The behaviour that fills the column lives in
 * `tests/integration/assistant-profile-service.db.test.ts`, which needs a
 * database. These are the parts that do not.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

const locales = { en, ko, zh, fr, de, es, pt };

test("the composer tells the two empty states apart", () => {
    const source = read("components/chat/ChatInput.tsx");
    // The row reads `assistantProfile ? ... : removedAt ? ... : none`. Assert
    // the two keys and the branch that chooses between them, rather than the
    // exact formatting, which prettier owns.
    assert.match(
        source,
        /assistantProfileRemovedAt[\s\S]{0,120}chat\.toolsAssistantRemoved/,
        "the removed sentence must be chosen by the removal timestamp"
    );
    assert.ok(
        source.includes('t("chat.toolsAssistantNone")'),
        "the never-had-one sentence must still exist"
    );
});

test("every locale says something different for the two empty states", () => {
    // A key that resolves to the same sentence in some locale would put that
    // locale back where it started, with the distinction present in the code
    // and absent on screen.
    for (const [language, dictionary] of Object.entries(locales)) {
        const removed = dictionary.chat?.toolsAssistantRemoved;
        const none = dictionary.chat?.toolsAssistantNone;
        assert.equal(
            typeof removed,
            "string",
            `${language} has no chat.toolsAssistantRemoved`
        );
        assert.ok(removed.trim().length > 0, `${language} removed sentence is empty`);
        assert.notEqual(
            removed,
            none,
            `${language} says the same thing for "deleted" and "never had one"`
        );
    }
});

test("the conversation route clears the tombstone whenever the binding moves", () => {
    // Both directions: attaching a new assistant and detaching on purpose. The
    // sentence explains a state the owner did not choose, so once they choose
    // one it stops being true. The write sits at the top of the branch that
    // handles `assistantProfileId`, before the outcome is even known, which is
    // what makes "both directions" structural rather than remembered.
    const source = read("app/api/conversations/[conversationId]/route.ts");
    const branch = source.indexOf("if (body.assistantProfileId !== undefined) {");
    assert.ok(branch >= 0, "the profile binding branch moved; update this test");
    const clear = source.indexOf(
        "updateData.assistantProfileRemovedAt = null;",
        branch
    );
    const resolveCall = source.indexOf("resolveProfileBinding({", branch);
    assert.ok(clear > branch, "the tombstone is never cleared when binding changes");
    assert.ok(
        clear < resolveCall,
        "the clear must not depend on which outcome the binding planner returns"
    );
});

test("both conversation responses carry the tombstone beside the profile", () => {
    // The GET and the PATCH. A screen that got it from one and not the other
    // would show the notice until the next reload, or lose it on the reload.
    const source = read("app/api/conversations/[conversationId]/route.ts");
    const emissions = source.match(/assistantProfileRemovedAt:\s*\n?\s*\w+\.assistantProfileRemovedAt/g);
    assert.equal(
        emissions?.length,
        2,
        "expected the tombstone on both the GET and the PATCH response"
    );
});
