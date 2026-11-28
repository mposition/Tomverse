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
      await expect(columns.getByTestId("review-user-bubble")).toHaveCount(3);
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
      await expect(desktop.locator(".review-composer-slot .composer-actions .review-chip")).toHaveText(["Google", "OpenAI", "xAI"]);
      await desktop.getByRole("button", { name: "Professional", exact: true }).click();
      await expect(desktop.locator(".review-composer-slot .composer-actions .review-chip")).toHaveText([gemini!.name, gpt!.name, grok!.name]);
      await chip.focus();
      await desktop.keyboard.press("Alt+ArrowLeft");
      await desktop.keyboard.press("Alt+ArrowLeft");
      assert.deepEqual(await columnOrder(desktop), [gpt!.id, gemini!.id, grok!.id]);
    });

    await t.test("dragging a header onto another column reorders the columns", async () => {
      await column(grok!).locator(".review-column-head").dragTo(column(gpt!));
      assert.deepEqual(await columnOrder(desktop), [grok!.id, gpt!.id, gemini!.id]);
      await expect(desktop.locator(".review-composer-slot .composer-actions .review-chip")).toHaveText([grok!.name, gpt!.name, gemini!.name]);
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
      assert.equal(after.dispatches[0]!.contextBundle, "context-for-" + gemini!.id, "memory and the assistant reach the model through the turn's own context");
      assert.deepEqual(after.contexts, [gemini!.id]);
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
      assert.equal(geminiDispatch.contextBundle, undefined);
      assert.equal(state.contexts.length, 1, "a Review of several models prepares no context of its own");
    });

    await t.test("a model can be switched off, which leaves it out of the next send", async () => {
      await column(grok!).getByRole("button", { name: /^Pause panel \d, Grok 4\.5/ }).click();
      await expect(column(grok!)).toHaveAttribute("data-off", "true");
      await expect(desktop.locator(".review-composer-slot .composer-actions .review-chip")).toHaveText([gpt!.name, gemini!.name]);
      await column(grok!).getByRole("button", { name: /^Resume panel \d, Grok 4\.5/ }).click();
      await expect(desktop.locator(".review-composer-slot .composer-actions .review-chip")).toHaveCount(3);
    });

    await t.test('the "+" menu turns web search on for the Review and each model gets the position with the next question', async () => {
      // The device's own position service is replaced: one read, one fixed answer.
      await desktop.evaluate(`void Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition(done) { done({ coords: { latitude: -27.46551, longitude: 153.025879, accuracy: 23 }, timestamp: Date.now() }); },
      } })`);
      const composer = desktop.locator(".review-composer-slot form");
      const before = await columnsState(app);
      await composer.locator(".composer-tools > summary").click();
      const search = composer.getByTestId("tools-web-search-row");
      await expect(search).toHaveAttribute("aria-checked", "false");
      await search.click();
      await expect(search).toHaveAttribute("aria-checked", "true");
      const position = composer.getByTestId("tools-location-row");
      await position.click();
      await expect(position).toHaveAttribute("aria-checked", "true");
      await desktop.keyboard.press("Escape");
      await expect(composer.getByTestId("chat-location-status")).toBeVisible();
      assert.equal((await columnsState(app)).updates.length, before.updates.length, "nothing is saved until a question is sent");

      await desktop.getByRole("textbox", { name: "Review question" }).fill("What is open near me right now?");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(before.dispatches.length + 3);
      const sent = await columnsState(app);
      assert.equal(sent.updates.at(-1)!.webSearchMode, "always");
      assert.equal(sent.webSearchMode, "always");
      for (const dispatch of sent.dispatches.slice(-3)) {
        assert.equal(dispatch.webSearchMode, "always", dispatch.modelId);
        assert.deepEqual({ ...(dispatch.currentLocation as object), timestamp: 0 },
          { latitude: -27.466, longitude: 153.026, accuracy: 150, timestamp: 0 }, dispatch.modelId);
      }
      await expect(desktop.getByRole("textbox", { name: "Review question" })).toHaveValue("");
      await composer.locator(".composer-tools > summary").click();
      await expect(search).toHaveAttribute("aria-checked", "true");
      await desktop.keyboard.press("Escape");

      // A question for one model carries the position too and changes nothing about the Review.
      await column(gemini!).getByRole("textbox", { name: `Ask only ${gemini!.name}` }).fill("And the closest one?");
      await column(gemini!).getByRole("button", { name: `Send only to this model · ${gemini!.name}` }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(sent.dispatches.length + 1);
      const alone = await columnsState(app);
      assert.equal(alone.dispatches.at(-1)!.modelId, gemini!.id);
      assert.equal((alone.dispatches.at(-1)!.currentLocation as { accuracy: number }).accuracy, 150);
      assert.equal(alone.updates.length, sent.updates.length);

      // Switched off, the next question carries no position.
      await composer.getByTestId("chat-location-disable").click();
      await expect(composer.getByTestId("chat-location-status")).toHaveCount(0);
      await column(gemini!).getByRole("textbox", { name: `Ask only ${gemini!.name}` }).fill("Thanks.");
      await column(gemini!).getByRole("button", { name: `Send only to this model · ${gemini!.name}` }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(alone.dispatches.length + 1);
      assert.equal((await columnsState(app)).dispatches.at(-1)!.currentLocation, undefined);
    });

    await t.test("a question is dropped when the Review is left while its position is still being read", async () => {
      // The position now arrives only when the test releases it.
      await desktop.evaluate(`void Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        getCurrentPosition(done) { window.releasePosition = () => done({ coords: { latitude: -27.46551, longitude: 153.025879, accuracy: 23 }, timestamp: Date.now() }); },
      } })`);
      const composer = desktop.locator(".review-composer-slot form");
      await composer.locator(".composer-tools > summary").click();
      await composer.getByTestId("tools-location-row").click();
      await desktop.evaluate("window.releasePosition()");
      await expect(composer.getByTestId("tools-location-row")).toHaveAttribute("aria-checked", "true");
      await desktop.keyboard.press("Escape");
      const before = await columnsState(app);
      const question = desktop.getByRole("textbox", { name: "Review question" });
      await question.fill("Where should we meet?");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect(question).toBeDisabled();
      await desktop.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(desktop.locator(".review-composer-slot")).toHaveCount(0);
      await desktop.evaluate("window.releasePosition()");
      await desktop.waitForTimeout(700);
      const after = await columnsState(app);
      assert.equal(after.saves.length, before.saves.length, "nothing is saved to the Review that was left");
      assert.equal(after.dispatches.length, before.dispatches.length);
    });
  } finally {
    await closeReviewColumns(session);
  }
});

test("Deep Research in the Review \"+\" menu is one more column, put to that model alone and polled to its report", { timeout: 120_000, skip: !columnsOrigin }, async (t) => {
  const research = "perplexity/sonar-deep-research";
  const session = await launchReviewColumns({ width: 1600, height: 1000, research: true });
  const { app, desktop } = session;
  try {
    const column = (model: { id: string }) => desktop.locator(`[data-testid="review-column"][data-model-id="${model.id}"]`);
    const composer = desktop.locator(".review-composer-slot form");
    const row = composer.getByRole("button", { name: /^Deep Research/ });
    const openTools = () => composer.locator(".composer-tools > summary").click();

    await t.test("with every place taken the row says so and starts nothing", async () => {
      await desktop.getByRole("button", { name: "Professional", exact: true }).click();
      await desktop.getByRole("textbox", { name: "Review question" }).fill("What do primary sources say about the 1970s oil shocks?");
      await openTools();
      await expect(row).toBeDisabled();
      await expect(row).toContainText("needs a free model place");
      await desktop.keyboard.press("Escape");
    });

    await t.test("with a place free it asks for the depth and sends the question to Deep Research alone", async () => {
      await column(grok!).getByRole("button", { name: /^Pause panel \d, Grok 4\.5/ }).click();
      await openTools();
      await expect(row).toBeEnabled();
      await row.click();
      const setup = desktop.getByRole("dialog", { name: "Start Deep Research" });
      await expect(setup).toBeVisible();
      await setup.getByRole("button", { name: "Start research", exact: true }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(1);
      const state = await columnsState(app);
      const [dispatch] = state.dispatches;
      assert.equal(dispatch!.modelId, research);
      assert.equal(dispatch!.deepResearchDepth, "standard");
      assert.equal(dispatch!.admissionToken, undefined, "a run for one model has no shared admission");
      assert.deepEqual(state.contexts, [research], "the research prepares its own context");
      assert.deepEqual(state.saves.at(-1), { clientRequestId: state.saves.at(-1)!.clientRequestId,
        content: "What do primary sources say about the 1970s oil shocks?", modelId: research }, "the question is saved for Deep Research only");
      assert.deepEqual(state.models, [gpt!.id, gemini!.id, research], "the Review holds the models that are on, plus Deep Research");
      assert.equal(state.dispatches.filter(({ modelId }) => modelId !== research).length, 0, "no other model answers a research question");
    });

    await t.test("the column shows the report once the status check finishes, and has no follow-up box", async () => {
      await expect(desktop.getByTestId("review-column")).toHaveCount(3);
      // The column also carries the earlier answer of the model that left the Review, drawn under its own name; the report is Deep Research's own.
      await expect(column({ id: research }).locator(`[data-testid="review-answer"][data-model-id="${research}"]`)).toContainText("Research report with a reference.", { timeout: 20_000 });
      assert.equal((await columnsState(app)).polls, 1);
      await expect(column({ id: research }).getByTestId("review-model-only-form")).toHaveCount(0);
      await expect(column({ id: research }).locator(".review-column-title strong")).toHaveText("Perplexity Sonar Deep Research");
      await expect(column(gpt!).getByTestId("review-answer")).toHaveCount(1);
    });

    await t.test("a later question goes to the models that are on and the research column stays", async () => {
      await desktop.getByRole("textbox", { name: "Review question" }).fill("And what do the models think?");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(3);
      const state = await columnsState(app);
      assert.deepEqual(state.dispatches.slice(1).map(({ modelId }) => modelId).sort(), [gemini!.id, gpt!.id].sort());
      assert.ok(state.dispatches.slice(1).every(({ deepResearchDepth }) => deepResearchDepth === undefined));
      assert.deepEqual(state.models, [gpt!.id, gemini!.id, research]);
      await expect(desktop.getByTestId("review-column")).toHaveCount(3);
    });

    await t.test("Easy mode routes its providers to models and keeps the research column", async () => {
      await desktop.getByRole("button", { name: "Easy", exact: true }).click();
      await desktop.getByRole("textbox", { name: "Review question" }).fill("One more question for the providers.");
      await desktop.getByRole("button", { name: "Send Review question" }).click();
      await expect.poll(async () => (await columnsState(app)).dispatches.length).toBe(5);
      const state = await columnsState(app);
      assert.deepEqual(state.dispatches.slice(3).map(({ modelId }) => modelId).sort(), [gemini!.id, gpt!.id].sort());
      assert.deepEqual(state.models, [gpt!.id, gemini!.id, research], "the Review holds models, never provider names");
      assert.ok(state.updates.every((update) => !update.selectedModels || (update.selectedModels as string[]).every((id) => id === research || columnModels.some((model) => model.id === id))));
      await expect(desktop.getByTestId("review-column")).toHaveCount(3);
    });
  } finally {
    await closeReviewColumns(session);
  }
});
