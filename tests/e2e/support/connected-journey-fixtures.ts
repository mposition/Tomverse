import type { Page } from "@playwright/test";
import type { ConnectedJourneyProperties } from "../../../lib/connectedJourneyShared";

export async function observeConnectedJourneyEvents(page: Page, baseURL: string) {
  const events: ConnectedJourneyProperties[] = [];
  await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL }]);
  await page.addInitScript(() => localStorage.setItem("tomverse_analytics_consent_v1", "accepted"));
  await page.route("https://www.googletagmanager.com/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/analytics/events", route => {
    const body = route.request().postDataJSON();
    if (body.event_name === "connected_journey_step") events.push(body.properties);
    return route.fulfill({ status: 202, body: "" });
  });
  return events;
}
