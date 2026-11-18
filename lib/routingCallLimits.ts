/**
 * The output ceiling for Tomverse's small structured routing calls: the Smart
 * Adaptive router (with its combined image, search-plan and rewrite answers),
 * the image-intent check and the location-intent check.
 *
 * It exists for one reason: the worst-case cost of a call is held against the
 * provider operational budget before the call leaves, and that needs an output
 * figure. It is deliberately not tight. These calls answer with an id and a
 * sentence, or a rewritten prompt, and an OpenAI reasoning model spends its
 * reasoning against the same ceiling first; ceilings sized to the expected
 * answer (200, 400, 900) cut answers off whenever the reasoning ran long
 * (2026-11-18: router outcome "invalid", finishReason "length", on follow-up
 * turns) and the turn silently lost its pick. A call's time is bounded by its
 * own deadline, and the hold settles to what the call actually used, so a
 * generous ceiling only raises the amount briefly held -- about $0.004 for a
 * gpt-6-luna call.
 */
export const ROUTING_CALL_MAX_OUTPUT_TOKENS = 8_192;
