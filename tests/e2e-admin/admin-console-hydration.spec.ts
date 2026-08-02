import { expect, test } from "./support/console";

/**
 * The Admin Console must hydrate without a mismatch.
 *
 * This is not a style preference. `app/(site)/(application)/admin/loading.tsx`
 * puts every admin page inside a Suspense boundary, so the page is streamed:
 * the shell is flushed first and the page content arrives later, in a
 * `<div hidden>` that an inline script moves into place. If React has already
 * client-rendered that boundary -- which is how it recovers from a hydration
 * mismatch -- the script finds no placeholder to move the content into, and the
 * streamed copy is simply left in the document. Every control on the page then
 * exists twice: once in `<main>`, once in a stray hidden div at the end of
 * `<body>`.
 *
 * That is what took `admin-provider-verification.spec.ts` down on CI, where a
 * loaded runner puts server render and hydration in different seconds:
 * `getByTestId('provider-verify-perplexity') resolved to 2 elements`. It never
 * reproduced on a fast machine, because there the two renders read the same
 * second and agreed by accident.
 *
 * The trigger was `AdminConsoleShell`'s "Updated HH:MM:SS UTC" stamp, read from
 * `new Date()` during render. The mismatch is what this spec asserts against,
 * rather than the duplicate: a mismatch is deterministic once the clocks are
 * forced apart, while whether it goes on to strand a streamed copy depends on
 * how the stream and hydration happen to interleave.
 *
 * Delaying every script is what forces them apart. Without it the two renders
 * land milliseconds apart and a same-second collision hides the defect.
 */

const HYDRATION_ERROR =
  /hydrat|react\.dev\/errors\/(418|421|422|423|425)|did not match/i;

const SCRIPT_DELAY_MS = 1_500;

const adminRoutes = ["/admin/overview", "/admin/providers"] as const;

for (const route of adminRoutes) {
  test(`${route} hydrates without a mismatch when hydration lands a second late`, async ({
    page,
    signInAs,
  }) => {
    // Holding every script back stretches the load well past the default.
    test.setTimeout(120_000);
    await signInAs("owner");

    const complaints: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      const text = message.text();
      if (HYDRATION_ERROR.test(text)) complaints.push(text.slice(0, 400));
    });
    page.on("pageerror", (error) => {
      if (HYDRATION_ERROR.test(error.message)) {
        complaints.push(error.message.slice(0, 400));
      }
    });

    await page.route("**/*.js", async (scriptRequest) => {
      await new Promise((resolve) => setTimeout(resolve, SCRIPT_DELAY_MS));
      await scriptRequest.continue();
    });

    const response = await page.goto(route);
    expect(response?.status()).toBeLessThan(400);
    // The refresh stamp is written by a mount effect, so its arrival is proof
    // that this tree has hydrated and that any mismatch has already been
    // reported. The timeout is generous because every script on the page is
    // being held back on purpose.
    await expect(page.getByText(/Updated \d\d:\d\d:\d\d UTC/)).toBeVisible({
      timeout: 30_000,
    });

    expect(complaints, complaints.join("\n---\n")).toEqual([]);
  });
}

test("the provider console renders one verification control per provider", async ({
  page,
  signInAs,
}) => {
  await signInAs("ops");
  await page.goto("/admin/providers");
  await expect(page.getByText(/Updated \d\d:\d\d:\d\d UTC/)).toBeVisible();

  // Counted across the whole document rather than inside `<main>`: a stranded
  // streamed copy sits outside `<main>`, so scoping the query would hide the
  // very thing this asserts against.
  await expect(page.getByTestId("provider-verify-perplexity")).toHaveCount(1);
  await expect(page.getByTestId("provider-recover-perplexity")).toHaveCount(1);
});
