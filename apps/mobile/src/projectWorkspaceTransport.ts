import type { ProjectWorkspaceClient } from "@tomverse/api-client";

/**
 * The native shell's project workspace transport: the shared client bound to
 * the native bearer adapter and the native upload. Session scope (logout, a
 * switched account) is enforced by the caller that builds it.
 */
export type ProjectWorkspaceTransport = ProjectWorkspaceClient;
