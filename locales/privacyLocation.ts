const englishLocationParagraphs = [
  "Browser or device permission and Tomverse’s location state are separate. Your browser or device may retain an Allow permission across reloads. Tomverse starts with location inactive; its enabled state and automatic-request suppression are kept only in this tab’s memory and reset on reload or account change. Reloading alone does not read a position.",
  "If you turn location on, we read a fresh approximate position when you send each message and include it with that request to your selected AI providers. While location is inactive, sending a location-dependent question can also trigger an automatic permission request before answering. A short analysis by the configured routing AI model decides whether location is needed; it receives no device position. If your browser or device has retained Allow, that request can read a fresh position without another prompt, including after reload.",
  "Turning location off in the composer or + tools menu blocks further reads and automatic requests for the current session, even if browser permission remains Allow. Denying access also suppresses automatic requests for that session. Reload or account change resets this suppression; use browser or device settings to revoke lasting permission.",
  "We do not track location in the background or create a separate location history. An answer may mention a place and follows normal chat retention, export and sharing settings. You can provide a place manually instead."
] as const;

export const englishLocationBody = englishLocationParagraphs.join("\n\n");

export const englishLocationNotice = [
  { title: "Use and turn off", items: [
    "Tomverse starts with location inactive.",
    "Turning location off in the composer or + tools menu blocks further reads and automatic requests for the current session, even if browser permission remains Allow.",
    "Denying access also suppresses automatic requests for that session.",
    "You can provide a place manually instead.",
  ] },
  { title: "Permission requests", paragraphs: [englishLocationParagraphs[0], englishLocationParagraphs[2]] },
  { title: "Sending and retention", paragraphs: [englishLocationParagraphs[1], englishLocationParagraphs[3]] },
] as const;
