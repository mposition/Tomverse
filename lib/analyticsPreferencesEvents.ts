export const ANALYTICS_PREFERENCES_OPEN_EVENT =
  "tomverse:analytics-preferences-open";

export const openAnalyticsPreferences = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ANALYTICS_PREFERENCES_OPEN_EVENT));
};
