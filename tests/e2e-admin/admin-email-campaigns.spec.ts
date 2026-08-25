import {
  adminApi,
  consoleHeading,
  expect,
  test,
} from "./support/console";
import {
  seedCampaignLedger,
  setAppSettingDirectly,
} from "./support/database";

/**
 * The campaign console.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3;
 * docs/ui-contracts/admin-console-ia.md.
 *
 * The campaigns are created through the API rather than seeded, for two
 * reasons. A seeded row would fix the shape of `EmailCampaign` in a fixture
 * file that nothing else reads, and — more to the point — the states this spec
 * is about (a draft that cannot be approved, a promise whose conditions are
 * unmet, a wave that came due and did not send) are produced by the write path,
 * so producing them any other way would assert against a state the application
 * cannot actually reach.
 */

const CAMPAIGN_API = "/api/admin/email-campaigns";

/** The `AppSetting` key the campaign feature lives behind. */
const CAMPAIGNS_FLAG = "feature.emailCampaignsEnabled";

/** A template key that exists, so `createCampaignDraft` does not reject it. */
const TEMPLATE_KEY = "model_launch";

const draftCampaign = async (
  api: ReturnType<typeof adminApi>,
  overrides: Record<string, unknown> = {}
) => {
  const response = await api.post(CAMPAIGN_API, {
    category: "model_retirement",
    templateKey: TEMPLATE_KEY,
    locales: ["en"],
    audienceSpec: {
      cohort: {
        kind: "model_retirement",
        targetModelId: "gpt-5-4-mini",
        replacementModelId: "gpt-5-6-luna",
      },
    },
    ...overrides,
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { campaign: { id: string } };
  return body.campaign.id;
};

test.describe("Admin Console — email campaigns", () => {
  test("the workspace is reachable, tabbed, and says what it is bounded to", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/email-campaigns");

    await expect(consoleHeading(page)).toHaveText("Email campaigns");

    // A section lives in `?tab=`, and the tabs are links: the admin IA contract
    // requires an operator's section to survive a bookmark and a back button.
    const tabs = page.getByRole("navigation", {
      name: "Email campaign sections",
    });
    await expect(tabs.getByRole("link", { name: "Campaigns" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Schedule" })).toBeVisible();

    await expect(
      page.getByText("Showing the newest 100", { exact: false })
    ).toBeVisible();

    await tabs.getByRole("link", { name: "Schedule" }).click();
    await expect(page).toHaveURL(/tab=schedule/);
    await expect(
      page.getByRole("heading", { name: "Wave schedule" })
    ).toBeVisible();

    // Deep-linked directly, not only reached by clicking.
    await page.goto("/admin/email-campaigns?tab=schedule");
    await expect(
      page.getByRole("heading", { name: "Wave schedule" })
    ).toBeVisible();
  });

  test("an empty console says there are none rather than showing nothing", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/email-campaigns");
    await expect(
      page.getByText("No campaigns have been drafted.")
    ).toBeVisible();

    await page.goto("/admin/email-campaigns?tab=schedule");
    await expect(
      page.getByTestId("admin-campaign-schedule-clear")
    ).toBeVisible();
  });

  test("a drafted campaign is listed and opens its own page", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));

    await page.goto("/admin/email-campaigns");
    const row = page.getByTestId("admin-campaign-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(TEMPLATE_KEY);
    await expect(row).toContainText("draft");

    await row.getByRole("link", { name: TEMPLATE_KEY }).click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/email-campaigns/${campaignId}$`)
    );
    await expect(consoleHeading(page)).toHaveText("Campaign detail");
  });

  test("the expansion ledger names people, masked, and reveals them on the record", async ({
    page,
    signInAs,
  }) => {
    // D10, decided 2026-08-24:
    // .github/audits/model-lifecycle-email-2026-08-22.md §21.
    // Until it was decided this screen showed counts and said on itself that
    // building the list would be answering an open question.
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await seedCampaignLedger({
      campaignId,
      addresses: ["candidate@example.test", "another@example.test"],
    });

    await page.goto(`/admin/email-campaigns/${campaignId}`);

    // The ledger is not loaded until it is asked for: one row per person is not
    // what an operator opening a campaign to check its schedule asked to read.
    await expect(page.getByTestId("admin-wave-ledger")).toHaveCount(0);

    await page.getByTestId("admin-campaign-audience-open-ledger").click();
    const ledger = page.getByTestId("admin-wave-ledger");
    await expect(ledger).toBeVisible();
    await expect(page.getByTestId("admin-wave-ledger-row")).toHaveCount(2);

    // Masked, and the local part is genuinely absent from the page rather than
    // merely not displayed -- the response never carried it.
    await expect(ledger).toContainText("c•••e@example.test");
    expect(await page.content()).not.toContain("candidate@example.test");

    await page.getByTestId("admin-reveal-addresses").click();
    await expect(page.getByTestId("admin-reveal-done")).toBeVisible();
    await expect(ledger).toContainText("candidate@example.test");
    await expect(ledger).toContainText("another@example.test");

    // Reloading masks them again: the reveal is an event, not a state. Nothing
    // about the page's URL carries it.
    await page.reload();
    await page.getByTestId("admin-campaign-audience-open-ledger").click();
    await expect(page.getByTestId("admin-wave-ledger")).toContainText(
      "c•••e@example.test"
    );
    expect(await page.content()).not.toContain("candidate@example.test");
  });

  test("support sees the ledger and is told why the addresses stay masked", async ({
    page,
    signInAs,
  }) => {
    // The control renders for everybody and says which it is. A button that
    // vanishes for some administrators is indistinguishable from a screen that
    // has no such feature.
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await seedCampaignLedger({
      campaignId,
      addresses: ["candidate@example.test"],
    });

    await signInAs("support");
    await page.goto(`/admin/email-campaigns/${campaignId}`);
    await page.getByTestId("admin-campaign-audience-open-ledger").click();

    await expect(page.getByTestId("admin-reveal-not-permitted")).toBeVisible();
    await expect(page.getByTestId("admin-reveal-addresses")).toHaveCount(0);
    expect(await page.content()).not.toContain("candidate@example.test");

    // And the server refuses regardless of what the browser renders.
    const refused = await adminApi(page).post(
      "/api/admin/email-deliveries/reveal",
      { kind: "campaign_recipient", ids: ["anything"] }
    );
    expect(refused.status()).toBe(403);
  });

  test("the detail page states what the send gate refuses, and does so from the server", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));

    await page.goto(`/admin/email-campaigns/${campaignId}`);

    // A draft is refused because it is a draft. The screen repeats the
    // server's refusal rather than deciding for itself whether it could send.
    const refusal = page.getByTestId("admin-campaign-send-refusal");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("Send refused");
  });

  test("all three attestations start unsaid, and recording one names who said it", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await page.goto(`/admin/email-campaigns/${campaignId}`);

    const differences = page.getByTestId(
      "admin-campaign-attestation-differences_stated"
    );
    await expect(differences).toContainText("Nobody has said this.");
    await expect(
      page.getByTestId("admin-campaign-attestation-staging_verified")
    ).toContainText("Nobody has said this.");
    await expect(
      page.getByTestId("admin-campaign-attestation-reconciliation_ready")
    ).toContainText("Nobody has said this.");

    await differences.getByRole("button", { name: "I checked this" }).click();

    // The signer, not a tick: an attestation with nobody's name on it is a
    // parameter somebody passed.
    await expect(differences).toContainText("@", { timeout: 15_000 });
    await expect(
      differences.getByRole("button", { name: "Withdraw" })
    ).toBeVisible();
  });

  test("a campaign that promises an automatic transition lists what is unmet", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const api = adminApi(page);
    const campaignId = await draftCampaign(api);

    const patched = await api.patch(`${CAMPAIGN_API}/${campaignId}`, {
      targetModelId: "gpt-5-4-mini",
      replacementModelId: "gpt-5-6-luna",
      claimsAutomaticTransition: true,
    });
    expect(patched.status()).toBe(200);

    await page.goto(`/admin/email-campaigns/${campaignId}`);
    const claim = page.getByTestId("admin-campaign-transition-claim");
    await expect(claim).toBeVisible();
    await expect(claim).toContainText("promises an automatic transition");
    // Named one by one. "Not ready" would leave an operator with nothing to do.
    await expect(claim).toContainText("work_item_approved_retirement");
  });

  test("approving asks for a reason and is refused while the gates say no", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page), {
      locales: ["en", "ko"],
    });
    await page.goto(`/admin/email-campaigns/${campaignId}`);

    // Approving is the two-person action, and the screen says which languages
    // the request will carry -- that list is in the approval payload, so a
    // campaign whose locales moved cannot inherit an old approval.
    await expect(
      page.getByTestId("admin-campaign-approve-locales")
    ).toHaveText("en, ko");

    const approve = page.getByTestId("admin-campaign-approve");
    await expect(approve).toBeDisabled();

    await page
      .getByTestId("admin-campaign-approve-reason")
      .fill("Read the copy in both languages.");
    await expect(approve).toBeEnabled();
  });

  test("a wave that came due and did not send is hoisted above what is merely upcoming", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const api = adminApi(page);
    const campaignId = await draftCampaign(api);

    // `approved_schedule` on an unapproved campaign is exactly the state the
    // scheduler refuses: the wave comes due, nothing sends, and the row keeps
    // no record of either. That is the row this section exists for.
    const overdue = await api.post(`${CAMPAIGN_API}/${campaignId}/waves`, {
      kind: "launch",
      action: "schedule",
      scheduledAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    });
    expect(overdue.status()).toBe(200);

    const upcoming = await api.post(`${CAMPAIGN_API}/${campaignId}/waves`, {
      kind: "reminder",
      action: "schedule",
      scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString(),
    });
    expect(upcoming.status()).toBe(200);

    await page.goto("/admin/email-campaigns?tab=schedule");
    await expect(page.getByTestId("admin-campaign-wave-overdue")).toHaveCount(1);
    await expect(page.getByTestId("admin-campaign-wave-upcoming")).toHaveCount(1);

    // The reason is not on the wave and the screen does not pretend it is.
    await expect(
      page.getByText("CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE")
    ).toBeVisible();

    // And the campaign list carries the same fact, so an operator who never
    // opens the schedule tab still sees it.
    await page.goto("/admin/email-campaigns");
    await expect(page.getByTestId("admin-campaign-overdue")).toContainText(
      "1 overdue"
    );
  });

  test("a campaign with no expansion says nobody has been considered", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await page.goto(`/admin/email-campaigns/${campaignId}`);

    const audience = page.getByTestId("admin-campaign-audience");
    await expect(audience).toBeVisible();
    await expect(audience).toContainText("No wave has expanded yet");
  });

  test("the ledger is read back as counts, and a dry run is never reported as a send", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const api = adminApi(page);
    const campaignId = await draftCampaign(api);

    // A dry run is the case worth driving through the browser: it writes the
    // same rows a real wave writes, and only the wave's own flag separates
    // "would have reached" from "reached".
    const scheduled = await api.post(`${CAMPAIGN_API}/${campaignId}/waves`, {
      kind: "launch",
      action: "schedule",
      scheduledAt: null,
      dryRun: true,
    });
    expect(scheduled.status()).toBe(200);

    await page.goto(`/admin/email-campaigns/${campaignId}`);
    const wave = page.getByTestId("admin-campaign-audience-wave");
    await expect(wave).toHaveCount(1);
    await expect(wave).toContainText("This wave has not expanded.");

    // No address is on the page at any point: the ledger holds them and whether
    // an operator may see them is still an open decision.
    await expect(page.getByTestId("admin-campaign-audience")).not.toContainText(
      "@"
    );
  });

  test("an unmeasured audience says nobody has counted it, not zero", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await page.goto(`/admin/email-campaigns/${campaignId}`);

    const estimate = page.getByTestId("admin-campaign-estimate");
    await expect(estimate).toBeVisible();
    await expect(
      page.getByTestId("admin-campaign-estimate-absent")
    ).toContainText("Nobody has measured this audience");
    // "not measured", never "0": a count nobody has taken and a count that came
    // back nought are different facts.
    await expect(estimate).not.toContainText("would receive the notice");
  });

  test("measuring the audience stores a number that says when it was taken", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));
    await page.goto(`/admin/email-campaigns/${campaignId}`);

    await page.getByTestId("admin-campaign-estimate-run").click();

    // Zero people are affected in this fixture, and that is a measurement:
    // the headline appears, dated and attributed.
    await expect(
      page.getByTestId("admin-campaign-estimate-headline")
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("admin-campaign-estimate")).toContainText(
      "Measured"
    );
    await expect(
      page.getByTestId("admin-campaign-estimate-absent")
    ).toHaveCount(0);
  });

  test("an unknown campaign id shows the not-found page, not an empty detail panel", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto("/admin/email-campaigns/does-not-exist-at-all");

    // The not-found UI, not a panel that quietly renders nothing: a stale link
    // has to say it is stale.
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page" })
    ).toBeVisible();
    await expect(page.getByTestId("admin-campaign-gates")).toHaveCount(0);

    // Asserted rather than the status code, deliberately. `notFound()` runs
    // after the shell has streamed, so the response is already a 200 and the
    // status cannot change (node_modules/next/dist/docs/01-app/03-api-reference
    // /04-functions/not-found.md, "Calling notFound() after streaming has
    // started"). What keeps a soft 404 honest is the noindex tag, and that is
    // the thing worth checking.
    // `.first()` because the layout emits its own robots tag alongside the one
    // `notFound()` injects; the assertion is that a noindex tag is present, not
    // that exactly one is.
    await expect(
      page.locator('meta[name="robots"][content*="noindex"]').first()
    ).toBeAttached();
  });

  test("with the feature switched off the console still reads, and refuses to act", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const api = adminApi(page);
    const campaignId = await draftCampaign(api);

    // Written straight to the row, because no admin API writes this key and
    // that absence is the decision (EM-05, ADR section 15.2): activation is a
    // judgement recorded by an operator, not a checkbox. A writer added for
    // this test's convenience would remove the decision it is testing.
    await setAppSettingDirectly(CAMPAIGNS_FLAG, "false");

    // Reading still works. An operator who cannot see what the feature already
    // did cannot tell it apart from broken, and this console is the only place
    // campaign waves are readable at all.
    await page.goto("/admin/email-campaigns");
    await expect(consoleHeading(page)).toHaveText("Email campaigns");
    await expect(page.getByTestId("admin-campaign-row")).toHaveCount(1);

    // Acting does not.
    const refused = await api.post(`${CAMPAIGN_API}/${campaignId}/estimate`);
    expect(refused.status()).toBeGreaterThanOrEqual(400);
  });

  test("a support administrator can read the workspace but not write to it", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    const campaignId = await draftCampaign(adminApi(page));

    await signInAs("support");
    await page.goto(`/admin/email-campaigns/${campaignId}`);
    await expect(consoleHeading(page)).toHaveText("Campaign detail");

    // `writeRoles` on the nav entry only drives the sidebar's "Read" marker;
    // the answer that matters comes from the route handler.
    const refused = await adminApi(page).post(
      `${CAMPAIGN_API}/${campaignId}/attestations`,
      { kind: "staging_verified" }
    );
    expect(refused.status()).toBe(403);
  });
});
