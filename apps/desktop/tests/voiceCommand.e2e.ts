import assert from "node:assert/strict";
import test from "node:test";
import { expect } from "@playwright/test";
import { closeReviewColumns, columnModels, columnsOrigin, columnsState, launchReviewColumns } from "./review-columns-fixture";

test("in Review a spoken instruction is sent as typed words are, and dictation only fills the draft", { timeout: 120_000, skip: !columnsOrigin }, async () => {
  const session = await launchReviewColumns({ width: 1600, height: 1000 });
  const { app, desktop } = session;
  try {
    const composer = desktop.locator(".review-composer-slot form");
    const question = desktop.getByRole("textbox", { name: "Review question" });
    const recording = desktop.getByRole("status").filter({ hasText: /^Recording [1-9][0-9]*s$/ });
    // The fixture server routes no Easy question: the models are named, as in Professional mode.
    await composer.getByRole("button", { name: "Professional", exact: true }).click();

    // The window cannot open the microphone by itself: only a press of one of the two buttons does.
    await assert.rejects(desktop.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }), /NotAllowedError|Permission denied/);

    // Dictation: the words land in the draft and nothing is sent.
    const before = await columnsState(app);
    await question.fill("Compare these");
    await composer.getByRole("button", { name: "Record voice input", exact: true }).click();
    await expect(recording).toBeVisible();
    await composer.getByRole("button", { name: "Use recording as text", exact: true }).click();
    await expect(question).toHaveValue("Compare these Which one is cheaper to run?");
    assert.equal((await columnsState(app)).saves.length, before.saves.length);
    // With words in the draft the ordinary Send button is back.
    await expect(composer.getByTestId("voice-command")).toHaveCount(0);
    await expect(composer.getByRole("button", { name: "Send Review question" })).toBeEnabled();

    // A spoken instruction: an empty draft, one press to start, one to send.
    await question.fill("");
    const speak = composer.getByTestId("voice-command");
    await expect(speak).toHaveAccessibleName("Speak an instruction");
    await expect(composer.getByRole("button", { name: "Send Review question" })).toHaveCount(0);
    await speak.click();
    await expect(recording).toBeVisible();
    await composer.getByRole("button", { name: "Send what I said", exact: true }).click();
    await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(before.dispatches.length + columnModels.length);
    const after = await columnsState(app);
    assert.equal(after.saves.at(-1)!.content, "Which one is cheaper to run?");
    assert.equal(after.saves.at(-1)!.modelId, undefined, "it goes to every model of the Review, like a typed question");
    assert.equal(after.clips, 2);
    await expect(question).toHaveValue("");
    // Nothing is read back: no voice session was opened for it.
    assert.equal(after.voiceRequests, 0);
  } finally {
    await closeReviewColumns(session);
  }
});
