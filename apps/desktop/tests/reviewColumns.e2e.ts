import assert from "node:assert/strict";
import test from "node:test";
import { expect } from "@playwright/test";
import { closeReviewColumns, columnModels, columnOrder, columnsOrigin, columnsQuestion, columnsState, launchReviewColumns } from "./review-columns-fixture";

const [gpt, gemini, grok] = columnModels;

test("Desktop Review shows one column per model, as the web does", { timeout: 120_000, skip: !columnsOrigin }, async (t) => {
  const session = await launchReviewColumns({ width: 1600, height: 1000 });
  const { app, desktop } = session;
  try {
    const columns = desktop.getByTestId("review-column");
    const column = (model: { id: string }) => desktop.locator(`[data-testid="review-column"][data-model-id="${model.id}"]`);

    await t.test("each column carries the logo, the display name and the provider, never the raw model id", async () => {
      await expect(desktop.getByTestId("review-column-head").locator("strong")).toHaveText(columnModels.map((model) => model.name));
      await expect(column(gpt!).locator(".review-column-title small")).toHaveText("OpenAI");
      await expect(column(gemini!).locator(".review-column-title small")).toHaveText("Google");
      await expect(column(grok!).locator(".review-column-title small")).toHaveText("xAI");
      await expect(column(gpt!).locator(".review-column-head img")).toHaveCount(1);
      for (const model of columnModels) await expect(desktop.getByText(model.id, { exact: true })).toHaveCount(0);
    });

    await t.test("an older answer saved without its model is still shown with its question", async () => {
      const legacy = desktop.getByTestId("review-unlabelled-answer");
      await expect(legacy).toHaveCount(1);
      await expect(legacy).toContainText("An older answer saved without its model.");
      await expect(columns.getByText("An older answer saved without its model.")).toHaveCount(0);
    });

    await t.test("the question is the user's chat bubble in every column, not a heading", async () => {
      await expect(desktop.getByRole("heading", { name: columnsQuestion })).toHaveCount(0);
      await expect(desktop.getByTestId("review-user-bubble")).toHaveCount(3);
      for (let index = 0; index < 3; index++) await expect(columns.nth(index).getByTestId("review-user-bubble")).toContainText(columnsQuestion);
      const bubble = columns.first().getByTestId("review-user-bubble");
      const [bubbleBox, columnBox] = await Promise.all([bubble.boundingBox(), columns.first().boundingBox()]);
      assert.ok(bubbleBox && columnBox && bubbleBox.x + bubbleBox.width > columnBox.x + columnBox.width - 40, "the bubble is aligned to the right");
    });

    await t.test("an answer shows its model, the web search badge, the table and the sources", async () => {
      await expect(column(gpt!).getByTestId("review-answer-model")).toHaveText(gpt!.name);
      await expect(column(gpt!).getByTestId("review-search-badge")).toHaveText("Web searched");
      await expect(column(gemini!).getByTestId("review-search-badge")).toHaveCount(0);
      await expect(column(gpt!).getByRole("table")).toBeVisible();
      await expect(column(gpt!).getByRole("button", { name: "Copy response" })).toBeVisible();
      await expect(column(gpt!).getByTestId("desktop-search-citation")).toHaveCount(2);
      await expect(column(gpt!).getByRole("button", { name: /Report a problem/ })).toBeVisible();
    });

    await t.test("the answer analysis buttons sit above the composer, outside its form", async () => {
      const actions = desktop.getByRole("group", { name: "Compare the answers" });
      await expect(actions.getByRole("button", { name: "Analyze answers with Tomverse" })).toBeVisible();
      assert.equal(await actions.evaluate((node) => Boolean(node.closest("form"))), false);
      assert.equal(await desktop.getByRole("form", { name: "Review composer" }).getByRole("button", { name: "Analyze answers with Tomverse" }).count(), 0);
      const [actionBox, formBox, columnsBox] = await Promise.all([actions.boundingBox(), desktop.getByRole("form", { name: "Review composer" }).boundingBox(),
        desktop.getByTestId("review-columns").boundingBox()]);
      assert.ok(actionBox && formBox && columnsBox);
      assert.ok(actionBox.y >= columnsBox.y + columnsBox.height - 2 && actionBox.y + actionBox.height <= formBox.y + 2);
    });

    await t.test("the focus view enlarges one model and the side-by-side view gives each the same width", async () => {
      const width = async (model: { id: string }) => (await column(model).boundingBox())!.width;
      await expect(desktop.getByTestId("review-columns")).toHaveAttribute("data-view", "focus");
      await expect(column(gpt!)).toHaveAttribute("data-focused", "true");
      assert.ok(await width(gpt!) > 1.4 * await width(gemini!));
      await desktop.getByTestId("review-focus-model").filter({ hasText: gemini!.name }).click();
      await expect(column(gemini!)).toHaveAttribute("data-focused", "true");
      assert.ok(await width(gemini!) > 1.4 * await width(gpt!));
      await desktop.getByRole("button", { name: "Side by side", exact: true }).click();
      await expect(desktop.getByTestId("review-columns")).toHaveAttribute("data-view", "compare");
      const widths = await Promise.all(columnModels.map(width));
      assert.ok(Math.max(...widths) - Math.min(...widths) < 4, "the three columns are as wide as each other");
      await expect(desktop.getByRole("button", { name: "Side by side", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(desktop.getByText("Drag a model card or answer header onto another answer to change the order.")).toBeVisible();
    });

    await t.test("the keyboard moves a model and the composer chips follow", async () => {
      assert.deepEqual(await columnOrder(desktop), columnModels.map((model) => model.id));
      const chip = desktop.getByTestId("review-focus-model").filter({ hasText: gpt!.name });
      await chip.focus();
      await desktop.keyboard.press("Alt+ArrowRight");
      assert.deepEqual(await columnOrder(desktop), [gemini!.id, gpt!.id, grok!.id]);
      await expect(chip).toBeFocused();
      await expect(desktop.getByRole("status").filter({ hasText: "moved to position 2 of 3" })).toHaveText(`${gpt!.name} moved to position 2 of 3.`);
      // Easy lists the providers; Professional lists the models.
      await expect(desktop.locator(".review-setup .review-chip")).toHaveText(["Google", "OpenAI", "xAI"]);
      await desktop.getByRole("button", { name: "Professional", exact: true }).click();
      await expect(desktop.locator(".review-setup .review-chip")).toHaveText([gemini!.name, gpt!.name, grok!.name]);
      await chip.focus();
      await desktop.keyboard.press("Alt+ArrowLeft");
      await desktop.keyboard.press("Alt+ArrowLeft");
      assert.deepEqual(await columnOrder(desktop), [gpt!.id, gemini!.id, grok!.id]);
    });

    await t.test("dragging a header onto another column reorders the columns", async () => {
      await column(grok!).locator(".review-column-head").dragTo(column(gpt!));
      assert.deepEqual(await columnOrder(desktop), [grok!.id, gpt!.id, gemini!.id]);
      await expect(desktop.locator(".review-setup .review-chip")).toHaveText([grok!.name, gpt!.name, gemini!.name]);
    });

    await t.test("one model can be asked alone and only its column continues", async () => {
      const before = await columnsState(app);
      assert.deepEqual(before.saves, []);
      const ask = column(gemini!).getByRole("textbox", { name: `Ask only ${gemini!.name}` });
      await expect(column(gemini!).getByRole("button", { name: `Send only to this model · ${gemini!.name}` })).toBeDisabled();
      await ask.fill("Can you give a one-line summary?");
      await column(gemini!).getByRole("button", { name: `Send only to this model · ${gemini!.name}` }).click();
      await expect(column(gemini!).getByText("Follow-up answer from " + gemini!.id)).toBeVisible();
      await expect(column(gemini!).getByTestId("review-user-bubble")).toHaveCount(2);
      await expect(column(gemini!).getByTestId("review-user-bubble").last()).toContainText("Can you give a one-line summary?");
      for (const other of [gpt!, grok!]) {
        await expect(column(other).getByTestId("review-user-bubble")).toHaveCount(1);
        await expect(column(other).getByText("Follow-up answer")).toHaveCount(0);
      }
      const after = await columnsState(app);
      assert.deepEqual(after.saves.map(({ content, modelId }) => ({ content, modelId })), [{ content: "Can you give a one-line summary?", modelId: gemini!.id }]);
      assert.equal(after.dispatches.length, 1);
      assert.equal(after.dispatches[0]!.modelId, gemini!.id);
      assert.equal(after.dispatches[0]!.admissionToken, undefined);
      assert.deepEqual(after.models, columnModels.map((model) => model.id), "the saved model list is untouched");
      assert.ok(after.dispatches[0]!.transcript.at(-1)!.endsWith("Can you give a one-line summary?"));
      await expect(ask).toHaveValue("");
      await expect(desktop.getByRole("textbox", { name: "Review question" })).toHaveValue("");
      // The analysis acts on the latest question, which only one model has answered.
      await expect(desktop.getByRole("group", { name: "Compare the answers" })).toHaveCount(0);
    });

    await t.test("a question for one model stays out of another model's later transcript", async () => {
      await desktop.getByRole("textbox", { name: "Review question" }).fill("What do you all think?");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect(column(gpt!).getByText("Follow-up answer from " + gpt!.id)).toBeVisible();
      await expect(column(grok!).getByText("Follow-up answer from " + grok!.id)).toBeVisible();
      const state = await columnsState(app);
      const gptDispatch = state.dispatches.find(({ modelId }) => modelId === gpt!.id)!;
      assert.ok(gptDispatch.transcript.every((line) => !line.includes("one-line summary")));
      const geminiDispatch = state.dispatches.find(({ modelId, sourceUserMessageId }) => modelId === gemini!.id && sourceUserMessageId !== state.dispatches[0]!.sourceUserMessageId)!;
      assert.ok(geminiDispatch.transcript.some((line) => line.includes("one-line summary")));
      assert.equal(geminiDispatch.admissionToken, "columns-comparison");
    });

    await t.test("a model can be switched off, which leaves it out of the next send", async () => {
      await column(grok!).getByRole("button", { name: /^Pause panel \d, Grok 4\.5/ }).click();
      await expect(column(grok!)).toHaveAttribute("data-off", "true");
      await expect(desktop.locator(".review-setup .review-chip")).toHaveText([gpt!.name, gemini!.name]);
      await column(grok!).getByRole("button", { name: /^Resume panel \d, Grok 4\.5/ }).click();
      await expect(desktop.locator(".review-setup .review-chip")).toHaveCount(3);
    });
  } finally {
    await closeReviewColumns(session);
  }
});
