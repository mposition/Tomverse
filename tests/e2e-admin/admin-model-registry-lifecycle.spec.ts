import type { Page } from "@playwright/test";

import { FIXTURE_MODEL, expect, test } from "./support/console";

/**
 * The model registry list's lifecycle filter.
 *
 * The registry keeps returning every row -- `GET /api/admin/models` still
 * reads `getRuntimeModels({ includeCatalogDeleted: true })` -- so everything
 * here is about what the *list* shows. Three properties matter and each has a
 * failure mode worth naming:
 *
 *   * the default view hides rows but never loses them (a filter that made a
 *     model unreachable would be a deletion in disguise),
 *   * the URL carries the whole filter state, alongside the parameters this
 *     page does not own, and
 *   * narrowing the list never narrows the editor or the replacement-model
 *     selector, which read the full registry.
 */

const lifecycleFilter = (page: Page) =>
  page.getByTestId("model-registry-lifecycle-filter");

test.describe("model registry lifecycle filter", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("owner");
  });

  test("the default view shows operational models and states how many it holds back", async ({
    page,
  }) => {
    await page.goto("/admin/models");

    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
    for (const hidden of [
      FIXTURE_MODEL.disabled,
      FIXTURE_MODEL.retired,
      FIXTURE_MODEL.archived,
    ]) {
      await expect(page.getByText(hidden.name)).toHaveCount(0);
    }

    // The exclusion is disclosed, not silent: the counter reports the whole
    // registry and the note names the view doing the hiding.
    const summary = page.getByTestId("model-registry-result-summary");
    await expect(summary).toContainText(/^Showing \d+ of \d+ models/);
    await expect(summary).toContainText("outside the Operational view");
    // The default is the absent value, so the URL stays clean.
    await expect(page).toHaveURL(/\/admin\/models$/);
  });

  test("the all-models view shows enabled and non-enabled rows together", async ({
    page,
  }) => {
    await page.goto("/admin/models");
    await lifecycleFilter(page).selectOption("all");

    for (const model of [
      FIXTURE_MODEL.enabled,
      FIXTURE_MODEL.disabled,
      FIXTURE_MODEL.retired,
      FIXTURE_MODEL.archived,
    ]) {
      await expect(page.getByText(model.name).first()).toBeVisible();
    }
    await expect(page).toHaveURL(/lifecycle=all/);
    await expect(
      page.getByTestId("model-registry-result-summary")
    ).not.toContainText("outside the");
  });

  test("retired and archived are separate views, neither of them 'disabled'", async ({
    page,
  }) => {
    await page.goto("/admin/models");

    await lifecycleFilter(page).selectOption("retired");
    await expect(page.getByText(FIXTURE_MODEL.retired.name).first()).toBeVisible();
    for (const other of [
      FIXTURE_MODEL.enabled,
      FIXTURE_MODEL.disabled,
      FIXTURE_MODEL.archived,
    ]) {
      await expect(page.getByText(other.name)).toHaveCount(0);
    }
    await expect(
      page.getByTestId(`model-registry-lifecycle-badge-${FIXTURE_MODEL.retired.id}`)
    ).toHaveText("Retired");

    await lifecycleFilter(page).selectOption("archived");
    await expect(page.getByText(FIXTURE_MODEL.archived.name).first()).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.retired.name)).toHaveCount(0);
    await expect(
      page.getByTestId(`model-registry-lifecycle-badge-${FIXTURE_MODEL.archived.id}`)
    ).toHaveText("Archived");

    // A merely disabled row is neither of those.
    await lifecycleFilter(page).selectOption("disabled");
    await expect(page.getByText(FIXTURE_MODEL.disabled.name).first()).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.retired.name)).toHaveCount(0);
  });

  test("changing the lifecycle preserves the query, the provider, and parameters this page does not own", async ({
    page,
  }) => {
    await page.goto("/admin/models?provider=google&q=e2e&audit=42");

    await lifecycleFilter(page).selectOption("retired");

    await expect(page).toHaveURL(/provider=google/);
    await expect(page).toHaveURL(/q=e2e/);
    await expect(page).toHaveURL(/audit=42/);
    await expect(page).toHaveURL(/lifecycle=retired/);
    // All three filters are ANDed: only the google retired fixture survives.
    await expect(page.getByText(FIXTURE_MODEL.retired.name).first()).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.enabled.name)).toHaveCount(0);
  });

  test("a lifecycle URL is restored on a direct visit and on reload", async ({
    page,
  }) => {
    await page.goto("/admin/models?lifecycle=archived");

    await expect(lifecycleFilter(page)).toHaveValue("archived");
    await expect(page.getByText(FIXTURE_MODEL.archived.name).first()).toBeVisible();

    await page.reload();
    await expect(lifecycleFilter(page)).toHaveValue("archived");
    await expect(page.getByText(FIXTURE_MODEL.archived.name).first()).toBeVisible();
  });

  test("an unknown lifecycle value falls back to the operational view", async ({
    page,
  }) => {
    await page.goto("/admin/models?lifecycle=retried");

    await expect(lifecycleFilter(page)).toHaveValue("operational");
    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
    await expect(page.getByText(FIXTURE_MODEL.retired.name)).toHaveCount(0);
  });

  test("no results names the lifecycle view that produced the empty list", async ({
    page,
  }) => {
    await page.goto("/admin/models?lifecycle=retired&q=e2e-model-primary");

    await expect(page.getByTestId("model-registry-empty-state")).toHaveText(
      "No retired models match the current search and provider filters."
    );
  });

  test("clear filters resets the search, the provider, and returns to operational", async ({
    page,
  }) => {
    await page.goto("/admin/models?provider=google&q=e2e&lifecycle=retired&audit=42");

    await page.getByRole("button", { name: "Clear filters" }).click();

    await expect(lifecycleFilter(page)).toHaveValue("operational");
    await expect(page.getByTestId("model-registry-provider-filter")).toHaveValue("all");
    await expect(
      page.getByPlaceholder("Search name, model ID, API ID, provider, or purpose")
    ).toHaveValue("");
    await expect(page.getByText(FIXTURE_MODEL.enabled.name).first()).toBeVisible();
    // The page's own parameters are dropped; an unrelated one is kept.
    await expect(page).toHaveURL(/\/admin\/models\?audit=42$/);
  });

  test("a model hidden from the default view is still editable from its own view", async ({
    page,
  }) => {
    await page.goto("/admin/models?lifecycle=all");

    await page
      .getByRole("button", { name: `Edit ${FIXTURE_MODEL.retired.name}` })
      .click();

    const dialog = page.getByRole("dialog", {
      name: `Edit ${FIXTURE_MODEL.retired.name}`,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Runtime status")).toHaveValue("disabled");
  });

  test("the replacement model selector is not narrowed by the list filter", async ({
    page,
  }) => {
    await page.goto("/admin/models?lifecycle=retired");

    // Only the retired fixture is on screen...
    await expect(page.getByText(FIXTURE_MODEL.enabled.name)).toHaveCount(0);
    await page
      .getByRole("button", { name: `Edit ${FIXTURE_MODEL.retired.name}` })
      .click();

    const dialog = page.getByRole("dialog", {
      name: `Edit ${FIXTURE_MODEL.retired.name}`,
    });
    const replacement = dialog.getByLabel("Replacement model");
    // ...yet the selector still offers every non-archived registry row, which
    // is the array the list filter must never touch.
    await expect(
      replacement.locator("option", { hasText: FIXTURE_MODEL.enabled.name })
    ).toHaveCount(1);
    await expect(
      replacement.locator("option", { hasText: FIXTURE_MODEL.disabled.name })
    ).toHaveCount(1);
    // Archived rows stay excluded there, as they were before this filter.
    await expect(
      replacement.locator("option", { hasText: FIXTURE_MODEL.archived.name })
    ).toHaveCount(0);
  });
});
