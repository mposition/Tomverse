import { z } from "zod";

export const cliFixtureInput = z.object({
  executable: z.string().min(1).max(4096),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/).max(48),
  model: z.string().regex(/^[\w.:-]{1,160}$/),
  origin: z.url().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
  allowSavedHistory: z.literal(true).optional(),
  allowFileEdits: z.literal(true).optional(),
}).strict().refine((fixture) => !fixture.allowFileEdits || fixture.allowSavedHistory === true);

export type CliFixtureInput = z.infer<typeof cliFixtureInput>;

export const qwenSubscriptionBaseUrl = "https://api.qwen.ai/compatible-mode/v1";
export const qwenSubscriptionFixtureToken = "tomverse-qwen-loopback-only";
export const qwenFixtureInput = cliFixtureInput.safeExtend({ subscriptionCa: z.string().min(1).max(4096).optional() })
  .refine(({ subscriptionCa, allowFileEdits }) => !subscriptionCa || !allowFileEdits);
export type QwenFixtureInput = z.infer<typeof qwenFixtureInput>;
