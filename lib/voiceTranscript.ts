/**
 * Turning what the provider said into what may enter a draft.
 *
 * Contract: docs/policy/voice-input.md §12.
 *
 * Pure, and separate from the route for one reason: this is the last thing
 * that touches the transcript before it becomes text in the user's composer,
 * and it has to be assertable directly rather than through a request.
 *
 * ## What it does, and what it deliberately does not
 *
 * It normalises whitespace, refuses a transcript that turned out to be
 * nothing, and stops one that is impossibly long. That is all.
 *
 * It does **not** filter, correct, capitalise, punctuate, translate or
 * moderate. The transcript goes into an editable draft that the user reads
 * before sending, so this product's job is to put what was said in front of
 * them — silently improving it would mean the box no longer shows what the
 * microphone heard, and the one thing a user must be able to do here is spot
 * that the recogniser got it wrong.
 */

/**
 * Providers return a plain space for a clip with no speech, and sometimes a
 * lone punctuation mark for a clip that was only breath. Neither is a
 * transcript, and inserting either would put a stray character in a draft the
 * user then has to find and delete.
 *
 * The list is short and literal on purpose. Anything cleverer would be a
 * content filter, which §12 says this is not.
 */
const NON_SPEECH = new Set([".", "。", "…", "...", ",", "、", "?", "!"]);

export const normalizeVoiceTranscript = (
  raw: string,
  options: { maxCharacters: number }
): string | null => {
  // Newlines are preserved as spaces rather than dropped: a recogniser that
  // splits on a pause should not silently join two sentences into one word.
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (NON_SPEECH.has(collapsed)) return null;
  // Refused rather than truncated. A truncated transcript ends mid-sentence
  // with nothing to say it was cut, and the user would send it believing it
  // was what they said.
  if (collapsed.length > options.maxCharacters) return null;
  return collapsed;
};

/**
 * How the transcript joins whatever is already in the composer.
 *
 * Appending rather than replacing, because the draft is the user's and voice
 * input is one more way to add to it: a user who typed half a question and
 * then spoke the rest expects both. Replacing would make the microphone a
 * destructive control with no undo, which is the one thing a control next to a
 * half-written message must not be (docs/policy/voice-input.md §8.3).
 *
 * Exported and pure so the composer's behaviour is a tested fact rather than
 * an inline expression in a 4,000-line component.
 */
export const appendVoiceTranscript = (
  existingDraft: string,
  transcript: string
): string => {
  if (!existingDraft) return transcript;
  // A separator only when the draft does not already end in whitespace, so
  // speaking twice in a row does not accumulate double spaces.
  return /\s$/.test(existingDraft)
    ? `${existingDraft}${transcript}`
    : `${existingDraft} ${transcript}`;
};
