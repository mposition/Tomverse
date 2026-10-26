type Preview = Readonly<{
  outcome?: string;
  reconfirmRequired?: boolean;
  draftDigest?: string | null;
}>;

/** Attach only the exact digest just previewed. Registration remains a separate
 * owner click and the server independently verifies the confirmed draft. */
export function confirmAmuxIntakePreview(
  currentText: string,
  previewedText: string | null,
  preview: Preview,
): string | null {
  if (currentText !== previewedText ||
      preview.outcome !== "approval_required" ||
      preview.reconfirmRequired !== true ||
      !/^[0-9a-f]{64}$/.test(preview.draftDigest ?? "")) return null;
  try {
    const draft: unknown = JSON.parse(currentText);
    if (!draft || typeof draft !== "object" || Array.isArray(draft) ||
        Object.hasOwn(draft, "confirmationDigest")) return null;
    return JSON.stringify({ ...draft,
      confirmationDigest: preview.draftDigest });
  } catch { return null; }
}
