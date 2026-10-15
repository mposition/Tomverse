import { AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  frontierCatalogReadPermitted } from "./ideaFrontierCatalogWriteCore.ts";
import { AMUX_V4_INITIAL_PLAN_READBACK_ENV, AMUX_V4_INITIAL_PLAN_WRITE_ENV,
  initialPlanReadbackPermitted, initialPlanWritePermitted } from "./ideaInitialSourcePlanCore.ts";
import { AMUX_V4_IDEA_READBACK_ENV, AMUX_V4_IDEA_SUBMISSION_ENV,
  ideaSubmissionReadBackPermitted, ideaSubmissionWritePermitted } from "./ideaSubmissionCore.ts";
import { AMUX_V4_TRANSFER_PREVIEW_READ_ENV, AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV,
  transferPreviewReadPermitted, transferPreviewWritePermitted } from "./ideaTransferPreviewInputCore.ts";

/** The build-preview chain runs three routes' writers, so it needs every one of their switches. */
export function buildPreviewPermitted(env: Readonly<Record<string, string | undefined>>) {
  return ideaSubmissionWritePermitted(env[AMUX_V4_IDEA_SUBMISSION_ENV]) &&
    ideaSubmissionReadBackPermitted(env[AMUX_V4_IDEA_READBACK_ENV]) &&
    initialPlanWritePermitted(env[AMUX_V4_INITIAL_PLAN_WRITE_ENV]) &&
    initialPlanReadbackPermitted(env[AMUX_V4_INITIAL_PLAN_READBACK_ENV]) &&
    transferPreviewWritePermitted(env[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV]) &&
    transferPreviewReadPermitted(env[AMUX_V4_TRANSFER_PREVIEW_READ_ENV]) &&
    frontierCatalogReadPermitted(env[AMUX_V4_FRONTIER_CATALOG_READ_ENV]);
}
