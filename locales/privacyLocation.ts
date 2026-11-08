export const englishLocationNotice = [
  {
    title: "Use and turn off",
    items: [
      "Current location is off by default.",
      "Turn it off from the composer or + tools menu.",
      "You can provide a place manually instead.",
      "Turning location off or denying access suppresses further automatic requests for the current session.",
    ],
  },
  {
    title: "Permission requests",
    paragraphs: [
      "For a location-dependent question, the app can automatically request browser or device permission before answering.",
      "If you have already allowed access, it reads a fresh position without asking again, including after reload.",
      "A short analysis of your question by the configured routing AI model decides whether to request location; it receives no device position.",
      "The permission choice stays in this tab's memory and resets on reload or account change.",
      "Browser and device settings control the lasting permission.",
    ],
  },
  {
    title: "Sending and retention",
    paragraphs: [
      "If you turn it on and grant browser or device permission, we read a fresh approximate position when you send a message and include it with that request to your selected AI providers.",
      "We do not track your location in the background or create a separate location history.",
      "An AI answer may mention a place; that answer follows the normal chat retention, export and sharing settings.",
    ],
  },
] as const;

// Keep the existing locale key available as plain text without duplicating copy.
export const englishLocationBody = englishLocationNotice
  .flatMap<string>(section => "items" in section ? [...section.items] : [...section.paragraphs])
  .join(" ");
