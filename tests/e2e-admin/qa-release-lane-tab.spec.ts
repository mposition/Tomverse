import { expect, test } from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * Admin › QA and release › Merge lane (components/admin/QaReleaseLaneVerdictsSection.tsx):
 * what the lane did on its latest rounds and what it thinks of every open
 * develop pull request, from the one row the lane service writes each round.
 * The pull requests that are the operator's come first, with the files that
 * made them so, and are counted on the tab.
 */

const KEY = "qa_release.merge_lane.rounds";
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const record = {
  rounds: [
    { at: at(1), outcome: "hold" },
    { at: at(6), outcome: "idle" },
    { at: at(11), outcome: "merged" },
  ],
  verdicts: {
    at: at(6),
    list: [
      {
        number: 2881,
        title: "feat(chat): complete C21 native workflows",
        headRefName: "codex/chat-c21-completion",
        status: "human",
        reasons: ["gate_path"],
        files: [
          { path: ".github/workflows/pr-fast-gate.yml", reasons: ["gate_path"] },
          { path: "package.json", reasons: ["gate_path"] },
        ],
        failedChecks: [],
      },
      {
        number: 2891,
        title: "fix(chat): share Composer tools",
        headRefName: "codex/composer-parity",
        status: "fix",
        reasons: ["checks_failed"],
        files: [],
        failedChecks: ["PR Fast Gate › Chromium smoke"],
      },
      { number: 2895, title: "chore: back-merge main into develop", headRefName: "claude/to-develop/back-merge", status: "next", reasons: [], files: [], failedChecks: [] },
      { number: 2890, title: "auto-rec http1 fetch", headRefName: "claude/to-develop/auto-rec", status: "waiting", reasons: ["checks_pending"], files: [], failedChecks: [] },
      { number: 2692, title: "U21 integration proof", headRefName: "codex/u21", status: "draft", reasons: [], files: [], failedChecks: [] },
    ],
  },
};

const cleanup = async () => {
  await adminFixtureDatabase().appSetting.deleteMany({ where: { key: KEY } });
};

test.afterEach(cleanup);

test("the merge lane tab says what the lane is doing and which pull requests are the operator's, and why", async ({ page, signInAs }) => {
  await cleanup();
  await adminFixtureDatabase().appSetting.create({ data: { key: KEY, value: JSON.stringify(record) } });

  await signInAs("owner");
  await page.goto("/admin/qa-release?tab=lane");
  await page.getByRole("button", { name: "Decline", exact: true }).click();

  const section = page.getByTestId("qa-release-lane-verdicts");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("qa-release-lane-outcome")).toContainText("a dev deploy is in progress");

  const human = section.getByTestId("qa-release-lane-human");
  await expect(human.getByTestId("qa-release-lane-pr-2881")).toContainText(".github/workflows/pr-fast-gate.yml");
  await expect(human.getByTestId("qa-release-lane-pr-2881")).toContainText("CI or gate file");
  await expect(human.getByRole("link", { name: /Merge on GitHub/ })).toHaveAttribute("href", "https://github.com/mposition/Tomverse/pull/2881");

  await expect(section.getByTestId("qa-release-lane-fix")).toContainText("PR Fast Gate › Chromium smoke");
  await expect(section.getByTestId("qa-release-lane-queue")).toContainText("Merges next");
  await expect(section.getByTestId("qa-release-lane-waiting")).toContainText("CI running");
  await expect(section.getByTestId("qa-release-lane-drafts")).toContainText("1");
  await page.screenshot({ path: "test-results-admin/qa-release-lane-tab.png", fullPage: true });

  // The operator's count rides on the tab, from any tab of the page.
  await page.goto("/admin/qa-release?tab=overview");
  await expect(page.getByRole("link", { name: /^Merge lane/ })).toContainText("1");
});
