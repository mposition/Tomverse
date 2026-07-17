import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AiModel } from "@/lib/models";
import {
  AI_PROVIDERS,
  PROVIDER_API_CONFIGURATION,
  isApprovedProviderApiBaseUrl,
  isApprovedProviderApiKeyEnvName,
} from "@/lib/modelRegistryShared";

const nullablePositiveInt = (maximum: number) =>
  z.union([z.number().int().min(1).max(maximum), z.null()]).optional();

const nullableNonNegativeNumber = (maximum: number) =>
  z.union([z.number().finite().min(0).max(maximum), z.null()]).optional();

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use letters, numbers, dot, underscore, slash, or hyphen.")
  .refine((value) => !value.includes(".."), "Model ID cannot contain '..'.");

const modelFields = {
  name: z.string().trim().min(1).max(160),
  apiModel: z.string().trim().min(1).max(240),
  provider: z.enum(AI_PROVIDERS),
  icon: z.string().trim().max(24).default(""),
  bestFor: z.string().trim().max(240).default(""),
  minimumPlan: z.enum(["Guest", "Free", "Pro"]),
  usageClass: z.enum([
    "standard",
    "advanced",
    "premium",
    "reasoning",
    "premium-reasoning",
    "research",
    "deep-research",
  ]),
  creditWeight: z.number().int().min(1).max(1000),
  publiclyListed: z.boolean(),
  status: z.enum(["enabled", "limited", "disabled", "coming-soon"]),
  operationalReason: z.string().trim().max(500).default(""),
  userVisibleNote: z.string().trim().max(500).default(""),
  replacementModelId: z.union([modelIdSchema, z.literal(""), z.null()]).optional(),
  reasoning: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
  contextWindowTokens: nullablePositiveInt(20_000_000),
  supportsImage: z.boolean(),
  supportsNativePdf: z.boolean(),
  maxImages: nullablePositiveInt(100),
  maxBase64ImagePayloadBytes: nullablePositiveInt(100 * 1024 * 1024),
  maxOutputTokens: nullablePositiveInt(2_000_000),
  reservationOutputTokens: nullablePositiveInt(2_000_000),
  inputUsdPerMillionTokens: nullableNonNegativeNumber(100_000),
  outputUsdPerMillionTokens: nullableNonNegativeNumber(100_000),
  cachedInputPriceMultiplier: z.union([z.number().finite().min(0).max(1), z.null()]).optional(),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
};

const refineModelInput = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
  schema.superRefine((value, context) => {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.maxOutputTokens === "number" &&
      typeof candidate.reservationOutputTokens === "number" &&
      candidate.reservationOutputTokens > candidate.maxOutputTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["reservationOutputTokens"],
        message: "Reserved output tokens cannot exceed maximum output tokens.",
      });
    }
    if (
      candidate.id &&
      candidate.replacementModelId &&
      candidate.id === candidate.replacementModelId
    ) {
      context.addIssue({
        code: "custom",
        path: ["replacementModelId"],
        message: "A model cannot replace itself.",
      });
    }
  });

export const createModelRegistrySchema = refineModelInput(
  z.object({ id: modelIdSchema, ...modelFields }).strict()
);

export const updateModelRegistrySchema = refineModelInput(
  z.object(modelFields).strict()
);

export type ModelRegistryInput = z.infer<typeof createModelRegistrySchema>;

const nullable = <T>(value: T | null | undefined) => value ?? null;

export function registryInputToData(
  input: Omit<ModelRegistryInput, "id">,
  actor: { id?: string | null; email?: string | null }
): Omit<
  Prisma.ModelRegistryEntryUncheckedCreateInput,
  "id" | "createdAt" | "updatedAt"
> {
  const providerConfiguration = PROVIDER_API_CONFIGURATION[input.provider];
  return {
    name: input.name,
    apiModel: input.apiModel,
    provider: input.provider,
    apiBaseUrl: providerConfiguration.baseUrl,
    apiKeyEnvName: providerConfiguration.apiKeyEnvName,
    icon: input.icon,
    bestFor: input.bestFor,
    minimumPlan: input.minimumPlan,
    usageClass: input.usageClass,
    creditWeight: input.creditWeight,
    publiclyListed: input.publiclyListed,
    enabled: input.status === "enabled" || input.status === "limited",
    status: input.status,
    operationalReason: input.operationalReason || null,
    userVisibleNote: input.userVisibleNote || null,
    replacementModelId: input.replacementModelId || null,
    catalogDeleted: false,
    reasoning: input.reasoning && input.reasoning !== "none" ? input.reasoning : null,
    contextWindowTokens: nullable(input.contextWindowTokens),
    supportsImage: input.supportsImage,
    supportsNativePdf: input.supportsNativePdf,
    maxImages: input.supportsImage ? nullable(input.maxImages) : null,
    maxBase64ImagePayloadBytes: input.supportsImage
      ? nullable(input.maxBase64ImagePayloadBytes)
      : null,
    maxOutputTokens: nullable(input.maxOutputTokens),
    reservationOutputTokens: nullable(input.reservationOutputTokens),
    inputUsdPerMillionTokens: nullable(input.inputUsdPerMillionTokens),
    outputUsdPerMillionTokens: nullable(input.outputUsdPerMillionTokens),
    cachedInputPriceMultiplier: nullable(input.cachedInputPriceMultiplier),
    sortOrder: input.sortOrder,
    updatedById: actor.id || null,
    updatedByEmail: actor.email || null,
  };
}

export function validateProviderConfiguration(model: AiModel) {
  const defaults = PROVIDER_API_CONFIGURATION[model.provider];
  const warnings: string[] = [];
  if (!isApprovedProviderApiBaseUrl(model.provider, model.apiBaseUrl || defaults.baseUrl)) {
    warnings.push("Blocked: the stored API endpoint does not match the provider allowlist.");
  }
  if (!isApprovedProviderApiKeyEnvName(model.provider, model.apiKeyEnvName || defaults.apiKeyEnvName)) {
    warnings.push("Blocked: the stored API-key reference does not match the provider allowlist.");
  }
  if (!model.bestFor.trim()) {
    warnings.push("No user-facing purpose is configured; the model picker will show only the model name.");
  }
  if (
    model.inputCapabilities?.nativePdf &&
    !model.inputCapabilities?.image
  ) {
    warnings.push("Native PDF is enabled while image input is disabled. Confirm this provider combination.");
  }
  return {
    compatible:
      isApprovedProviderApiBaseUrl(model.provider, model.apiBaseUrl || defaults.baseUrl) &&
      isApprovedProviderApiKeyEnvName(model.provider, model.apiKeyEnvName || defaults.apiKeyEnvName),
    protocol: defaults.protocol,
    apiKeyEnvName: defaults.apiKeyEnvName,
    apiKeyConfigured: Boolean(process.env[defaults.apiKeyEnvName]?.trim()),
    warnings,
  };
}
