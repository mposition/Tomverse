/**
 * The seam between this system and whoever turns audio into text.
 *
 * Contract: docs/policy/voice-input.md §10.
 *
 * Modelled on `lib/emailProviderPortCore.ts`, deliberately and for the same
 * reasons. Framework-free — no `server-only`, no `next`, no Prisma, no SDK —
 * so the rules can be driven from a test without a request, and so nothing
 * that cannot import the server binding has a reason to write its own copy of
 * them.
 *
 * ## One method, and that is the design
 *
 * `transcribe`. Nothing else. No model listing, no usage query, no streaming,
 * no translation, no diarisation, no voice synthesis. Every one of those is a
 * capability some provider has and this product has not decided to want; a
 * port that grew them would be describing a provider rather than describing
 * what we ask a provider to do, and swapping the provider would then mean
 * re-implementing capabilities nothing calls.
 *
 * `VOICE_TRANSCRIPTION_PORT_SURFACE` names the method so a test can assert the
 * implementation has exactly it. The list is the enforcement, not a comment
 * about one.
 *
 * ## Why there is one implementation
 *
 * An abstraction written while only one thing implements it takes the shape of
 * that one thing. So this is not a provider-neutral interface: it is the
 * narrowest description of the request we make, and the next provider is
 * expected to need edits here. That is cheaper than the generality we would
 * otherwise be guessing at.
 *
 * ## What must never cross this boundary
 *
 * Audio bytes go out. Text comes back. Neither is ever logged, stored, or put
 * in an error — `transcribe` reports failures as codes and HTTP statuses, and
 * the provider's own message body is read only far enough to classify it
 * (docs/policy/voice-input.md §11). A `throw` carrying a response body is how
 * a transcript ends up in an error tracker.
 */

/** The methods a transcription provider must have, and the only ones. */
export const VOICE_TRANSCRIPTION_PORT_SURFACE = ["transcribe"] as const;

export type VoiceTranscriptionRequest = {
  /** The recorded container, exactly as it arrived. */
  audio: Uint8Array;
  /** A media type from `lib/voiceInputFormats.ts`, never a client string. */
  mediaType: string;
  /** The extension the multipart part is given, from the same table. */
  extension: string;
  /**
   * A BCP-47 hint, or `null` for automatic detection.
   *
   * A hint and not a filter: docs/policy/voice-input.md §12 supports Korean
   * and English first, and forcing a language would mean a user who switches
   * mid-sentence gets the wrong one transcribed rather than the right one
   * detected.
   */
  languageHint: string | null;
};

export type VoiceTranscriptionResult =
  | {
      ok: true;
      text: string;
      /**
       * Seconds of audio the provider says it processed, when it says so.
       *
       * This is the number the operational budget books, because it is the
       * number the provider bills (docs/policy/voice-input.md §7). `null` when
       * the response did not carry one.
       */
      durationSeconds: number | null;
    }
  | {
      ok: false;
      /** Classified below; never the provider's own prose. */
      code: VoiceTranscriptionFailure;
      /** The HTTP status, or `null` when no request was made. */
      status: number | null;
      /** True when the deployment has no key for this provider. */
      notConfigured?: boolean;
    };

export type VoiceTranscriptionFailure =
  /** No API key in this environment. */
  | "provider_not_configured"
  /** 401/403 — the key is wrong, not the request. */
  | "provider_rejected_credentials"
  /** 429, or a 5xx that the provider asks us to retry. */
  | "provider_unavailable"
  /** 400/415/422 — the provider would not take this clip. */
  | "provider_rejected_audio"
  /** The request never completed: timeout, DNS, socket. */
  | "provider_unreachable"
  /** A 2xx whose body was not the shape this port expects. */
  | "provider_response_unreadable";

export interface VoiceTranscriptionPort {
  transcribe(
    request: VoiceTranscriptionRequest
  ): Promise<VoiceTranscriptionResult>;
}

// ---------------------------------------------------------------------------
// The OpenAI implementation, as a pure function of its configuration
// ---------------------------------------------------------------------------

/**
 * The default transcription model.
 *
 * `gpt-4o-mini-transcribe` rather than the newer `gpt-transcribe`: this is the
 * cheapest published option that accepts every container in
 * `lib/voiceInputFormats.ts`, and while the credit price is undecided
 * (docs/policy/voice-input.md §6) the right default is the one that costs
 * least to leave switched off. The model is configuration, not a constant, so
 * changing it is an environment variable rather than a deploy.
 */
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** Beyond this the user has been staring at a spinner too long anyway. */
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 30_000;

export type OpenAiTranscriptionConfig = {
  apiKey: string;
  model: string;
  /** Injected so a test drives this without a network. */
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

const classifyStatus = (status: number): VoiceTranscriptionFailure => {
  if (status === 401 || status === 403) return "provider_rejected_credentials";
  if (status === 429) return "provider_unavailable";
  if (status >= 500) return "provider_unavailable";
  // 400, 413, 415, 422 and anything else in the 4xx range: the provider is
  // healthy and does not want this clip. Retrying sends the same bytes again.
  return "provider_rejected_audio";
};

export const transcribeWithOpenAi = async (
  request: VoiceTranscriptionRequest,
  config: OpenAiTranscriptionConfig
): Promise<VoiceTranscriptionResult> => {
  const form = new FormData();
  form.append(
    "file",
    new Blob([request.audio as unknown as BlobPart], { type: request.mediaType }),
    // The filename is generated, never derived from anything the user typed:
    // there is no filename in this flow, and inventing one from a transcript
    // or an account would put content into a multipart header.
    `voice.${request.extension}`
  );
  form.append("model", config.model);
  // `json`, not `verbose_json`: the only extra field this port wants is the
  // duration, and `verbose_json` also returns per-segment text with
  // timestamps — a second, longer copy of the transcript, for a number we can
  // do without. Less transcript on the wire is less transcript to leak.
  form.append("response_format", "json");
  if (request.languageHint) form.append("language", request.languageHint);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await config.fetchImpl(
      `${config.baseUrl ?? "https://api.openai.com"}/v1/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: controller.signal,
      }
    );
  } catch {
    // The thrown error is deliberately not inspected, not re-thrown and not
    // logged. `fetch` failures carry the request in their message on some
    // runtimes, and the request is the audio.
    return { ok: false, code: "provider_unreachable", status: null };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // The body is consumed and discarded rather than left unread: an
    // unconsumed body holds the connection open (npm run
    // report:unconsumed-response-bodies). It is never read into a variable
    // that could reach a log.
    await response.arrayBuffer().catch(() => undefined);
    return { ok: false, code: classifyStatus(response.status), status: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      code: "provider_response_unreadable",
      status: response.status,
    };
  }

  const body = payload as { text?: unknown; duration?: unknown } | null;
  if (!body || typeof body.text !== "string") {
    return {
      ok: false,
      code: "provider_response_unreadable",
      status: response.status,
    };
  }

  const duration =
    typeof body.duration === "number" && Number.isFinite(body.duration)
      ? body.duration
      : null;

  return { ok: true, text: body.text, durationSeconds: duration };
};
