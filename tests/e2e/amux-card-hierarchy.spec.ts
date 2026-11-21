import { expect, test, type Page } from "@playwright/test";

// Owner request 2026-11-21: a Task card shows Initiative > Epic > Feature >
// Story > Task, and a node step opens the owner's edit sheet.

const FEATURE = "33333333-cccc-4ccc-8ccc-000000000003";
const card = { id: "qa-task-crawl-002", title: "Allow AI search bots in robots.txt",
  displayKey: "AMUX-CRAWL-002", sourceKey: "AMUX-CRAWL-002", status: "todo", priority: "p2",
  kind: "code", cardType: "task", storyKind: null, parentFeatureNodeId: FEATURE,
  parentStoryCardId: "qa-story-crawl-001", taskRole: "impl", executionGrade: "standard",
  worker: null, lane: null, sev1: false, score: 62, scoreFresh: true, dependencyCount: 0,
  progress: null, briefPresent: true, updatedAt: "2026-11-21T05:00:00Z" };
const steps = (story = true) => [
  { kind: "node", level: "initiative", id: "11111111-aaaa-4aaa-8aaa-000000000001",
    title: "AI search visibility (AEO)", number: "#111111", archived: false, value: 4,
    weight: 4, editable: true },
  { kind: "node", level: "epic", id: "22222222-bbbb-4bbb-8bbb-000000000002",
    title: "Search bot access", number: "#222222", archived: true, value: null,
    weight: 3, editable: false },
  { kind: "node", level: "feature", id: FEATURE, title: "AEO-01 crawl policy",
    number: "AMUX-CRAWL", archived: false, value: 4, weight: 2, editable: true },
  story ? { kind: "card", level: "story", id: "qa-story-crawl-001",
    title: "Bots can read public pages", number: "AMUX-CRAWL-001", status: "in_progress",
    archived: false, metric: 4, current: false } :
    { kind: "missing", level: "story", reason: "no_story" },
  { kind: "card", level: "task", id: card.id, title: card.title, number: card.displayKey,
    status: "todo", archived: false, metric: 3, current: true },
];
const detail = (story: boolean) => ({ ...card, revision: 3, body: null, brief: null,
  feedback: null, result: null, dependencies: [], dependents: [], attempts: [],
  escalations: [], score: null, usage: [], reviews: [], publications: [],
  hierarchy: steps(story) });

async function setup(page: Page, story = true) {
  const posts: Array<{ action: string; [key: string]: unknown }> = [];
  let details = 0;
  await page.route("**/api/admin/amux/execution-view?**", async (route) => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get("view") === "detail") { details++; return route.fulfill({ json: detail(story) }); }
    if (p.get("view") === "board_snapshot") return route.fulfill({ json: { pageSize: 8,
      counts: { tomverse_backlog: 1, amux_backlog: 0, todo: 0, in_progress: 0, in_review: 0,
        attention: 0, archive: 0 },
      lanes: ["tomverse_backlog", "amux_backlog", "todo", "in_progress", "in_review", "attention"]
        .map((lane) => ({ lane, cards: lane === "tomverse_backlog" ? [card] : [] })) } });
    return route.fulfill({ json: { cards: [], counts: {} } });
  });
  await page.route("**/api/admin/amux/portfolio**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { id: FEATURE,
      level: "feature", state: "active", revision: 0, displayPrefix: "AMUX-CRAWL",
      content: { title: "AEO-01 crawl policy", description: "Let AI search bots read public pages." },
      editable: true, contentEditable: true, assessment: { version: 1, value: 4,
        uncertainty: "medium", reasonCode: "initial", evidenceAsOf: "2026-11-20T00:00:00.000Z",
        bound: true } } });
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.action === "preview_node_edit") return route.fulfill({ json: {
      confirmationDigest: "d".repeat(64), level: "feature", contentChanged: true,
      revisionAfter: 1, priorValue: 4, nextValue: body.payload.value,
      tasks: [{ taskId: card.id, displayKey: card.displayKey, currentScore: 62, projectedScore: 64 }],
      retryWrite: false } });
    return route.fulfill({ status: 201, json: { state: "saved", nodeId: FEATURE, revision: 1,
      contentRevised: true, tasks: [{ taskId: card.id, state: "scored", scoreTotal: 64 }],
      promotionAuthorized: false, retryWrite: false } });
  });
  await page.goto("/e2e/admin-console-fixture?view=amux");
  await page.getByTestId("amux-board-card-" + card.id)
    .getByRole("button", { name: card.displayKey, exact: true }).click();
  return { posts, details: () => details };
}

test("a Task card reads its whole line, top down, with archived steps marked", async ({ page }) => {
  await setup(page);
  const line = page.getByTestId("amux-card-hierarchy");
  await expect(line).toBeVisible();
  for (const [level, text] of [["initiative", "AI search visibility (AEO)"],
    ["epic", "Search bot access"], ["feature", "AMUX-CRAWL"],
    ["story", "AMUX-CRAWL-001"], ["task", "AMUX-CRAWL-002"]]) {
    await expect(line.getByTestId(`amux-hierarchy-${level}`)).toContainText(text);
  }
  await expect(line.getByTestId("amux-hierarchy-epic")).toHaveAttribute("data-state", "archived");
  await expect(line.getByTestId("amux-hierarchy-task")).toHaveAttribute("aria-current", "page");
  await expect(line.getByTestId("amux-hierarchy-feature")).toContainText("Value 4/5 · ×2");
  await page.screenshot({ path: "test-results/amux-card-hierarchy.png", fullPage: false });
});

test("a Feature-direct Task keeps an empty Story step", async ({ page }) => {
  await setup(page, false);
  const story = page.getByTestId("amux-hierarchy-story");
  await expect(story).toHaveAttribute("data-state", "missing");
  await expect(story).toContainText("No Story");
});

test("the Feature step opens the edit sheet; review then save goes through the portfolio route", async ({ page }) => {
  const { posts, details } = await setup(page);
  await page.getByTestId("amux-hierarchy-feature").click();
  const sheet = page.getByTestId("amux-node-sheet");
  await expect(sheet.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("AEO-01 crawl policy");
  await sheet.getByRole("textbox", { name: "Title", exact: true }).fill("AEO-01 crawl and llms.txt policy");
  await sheet.getByRole("radio", { name: "5", exact: true }).check();
  await sheet.getByTestId("amux-node-review").click();
  await expect(sheet.getByTestId("amux-node-preview")).toContainText("1 open Task");
  await expect(sheet.getByTestId("amux-node-preview")).toContainText("AMUX-CRAWL-002 62 → 64 (estimate)");
  await page.screenshot({ path: "test-results/amux-node-sheet.png", fullPage: false });
  await sheet.getByTestId("amux-node-save").click();
  await expect(sheet.getByRole("status")).toContainText("1 Task score recalculated");
  expect(posts.map((post) => post.action)).toEqual(["preview_node_edit", "save_node_edit"]);
  const preview = posts[0] as unknown as { payload: { content: { title: string }; value: number; reasonCode: string } };
  expect(preview.payload.content.title).toBe("AEO-01 crawl and llms.txt policy");
  expect(preview.payload.value).toBe(5);
  expect(preview.payload.reasonCode).toBe("operator_override");
  // The card is read again only when the sheet closes.
  const before = details();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(details).toBeGreaterThan(before);
});

test("an archived step opens read-only", async ({ page }) => {
  await setup(page);
  await expect(page.getByTestId("amux-hierarchy-epic")).toHaveAccessibleName(/^Epic details/);
});
