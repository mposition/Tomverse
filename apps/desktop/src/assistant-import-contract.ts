import { z } from "zod";
import { ASSISTANT_KNOWLEDGE_LIMITS } from "../../../lib/assistantKnowledgeLimits";
import { ASSISTANT_PROFILE_LIMITS } from "../../../lib/assistantProfileVersioning";
import { accountDataId } from "./account-data-contract";

// Importing an assistant package. The wizard is the web's own component; this is the
// typed surface it reaches the account through. The main process owns the file dialog,
// the account session and every request, so the window names an action and never a path.
// Imported by the main process too: no module that uses the web-only `@/` alias.

/** The container as it arrives: the same figure the web parser refuses above (B1). */
export const ASSISTANT_IMPORT_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const ASSISTANT_IMPORT_PACKAGE_EXTENSIONS = ["zip", "json"] as const;
// Same ceiling as the server's import request body.
const STAGING_MANIFEST_MAX_CHARACTERS = 256 * 1024;

const importId = accountDataId;
// `z.instanceof` would pin the buffer type to ArrayBuffer, which a view from a stream or a zip does not have.
const bytes = z.custom<Uint8Array>(value => value instanceof Uint8Array);
const identity = z.object({
  name: z.string().trim().min(1).max(ASSISTANT_PROFILE_LIMITS.maxNameCharacters),
  icon: z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxIconCharacters).nullable(),
  description: z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters).nullable(),
}).strict();

const createBody = z.object({
  mode: z.enum(["create", "merge"]),
  targetProfileId: accountDataId.optional(),
  identity,
  stagingManifest: z.record(z.string(), z.unknown())
    .refine(value => JSON.stringify(value).length <= STAGING_MANIFEST_MAX_CHARACTERS),
  declared: z.object({
    sourceKind: z.string().max(64).nullable(),
    sourceName: z.string().trim().max(200).nullable(),
    sourceUrl: z.string().trim().max(2_000).nullable(),
    previousProvenance: z.record(z.string(), z.unknown()).nullable(),
  }).strict(),
}).strict().refine(body => body.mode !== "merge" || !!body.targetProfileId);

const publishBody = z.object({
  approvedDigest: z.string().trim().min(1).max(200),
  digestVersion: z.number().int().positive(),
  keepFileIds: z.array(z.string().trim().min(1).max(64)).max(64),
  identity,
  draft: z.object({
    instructions: z.string().max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters),
    modelIds: z.array(z.string().trim().min(1).max(120)).max(16),
    toolPolicy: z.object({ webSearch: z.boolean(), deepResearch: z.boolean() }).strict(),
    memoryPolicy: z.object({ useAccountMemory: z.boolean() }).strict(),
    starters: z.array(z.string().trim().max(400)).max(16),
  }).strict(),
}).strict();

export const assistantImportInput = z.discriminatedUnion("action", [
  // The assistants the owner may merge into, and whether the server has the import on.
  z.object({ action: z.literal("targets") }).strict(),
  z.object({ action: z.literal("pickPackage") }).strict(),
  z.object({ action: z.literal("create"), body: createBody }).strict(),
  // The main process derives the type from the name and checks the bytes; the window's claim is not used.
  z.object({
    action: z.literal("upload"), importId, filename: z.string().trim().min(1).max(200),
    bytes: bytes.refine(data => data.byteLength > 0 && data.byteLength <= ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes),
  }).strict(),
  z.object({ action: z.literal("read"), importId }).strict(),
  z.object({ action: z.literal("publish"), importId, body: publishBody }).strict(),
  z.object({ action: z.literal("cancel"), importId }).strict(),
]);

const fileRow = z.object({
  id: z.string().min(1).max(128), name: z.string().max(400), processingStatus: z.string().max(40),
  failureCode: z.string().max(120).nullable(),
});

/** What the server answers, reduced to the fields the wizard reads. */
export const assistantImportOutput = {
  targets: z.object({
    enabled: z.boolean(),
    targets: z.array(z.object({
      id: accountDataId, name: z.string(), icon: z.string().nullable(),
      currentRevision: z.number().int().nullable(), knowledgeFileCount: z.number().int().nonnegative(),
    })),
  }),
  pickPackage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cancelled") }),
    z.object({ kind: z.literal("picked"), name: z.string().max(260), bytes }),
    // Refused before it was read: too large, or not a .zip or .json file.
    z.object({ kind: z.literal("refused"), code: z.enum(["ASSISTANT_PACKAGE_TOO_LARGE", "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED"]),
      name: z.string().max(260), size: z.number().int().nonnegative() }),
  ]),
  create: z.object({ id: importId, profileId: z.string().max(128), mode: z.string().max(20), status: z.string().max(40) }),
  upload: z.object({ id: z.string().min(1).max(128) }),
  read: z.object({
    id: importId, mode: z.string().max(20), status: z.string().max(40), profileId: z.string().max(128),
    ready: z.boolean(), files: z.array(fileRow).max(256),
  }),
  publish: z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("published"), version: z.object({ id: z.string(), revision: z.number().int() }) }),
    z.object({ outcome: z.literal("unchanged"), revision: z.number().int() }),
    z.object({ outcome: z.literal("not_ready"), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  ]),
  cancel: z.object({}),
} as const;

export type AssistantImportInput = z.infer<typeof assistantImportInput>;
export type AssistantImportAction = AssistantImportInput["action"];
export type AssistantImportOutput = { [Action in AssistantImportAction]: z.infer<(typeof assistantImportOutput)[Action]> };

/** A refusal keeps the HTTP status and the server's code; the message is never carried. */
export type AssistantImportResult<Action extends AssistantImportAction> =
  | { ok: true; value: AssistantImportOutput[Action] }
  | { ok: false; status: number; code: string };
