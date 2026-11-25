import { z } from "zod";

/**
 * Permission modes and allow / ask / deny rules, as the Code screen sees them.
 * The renderer only sends these typed commands; the main process validates them
 * (the rule itself is checked by the CLI's own `ruleProblem`) and is the only
 * place the mode and the rule files change. Nothing the model writes can send
 * one of these commands.
 */

export const permissionModes = ["read_only", "ask", "auto_review", "allow_all"] as const;
export const permissionMode = z.enum(permissionModes);
export type PermissionModeId = z.infer<typeof permissionMode>;

export const permissionRuleInput = z.object({
  effect: z.enum(["allow", "ask", "deny"]),
  tool: z.string().min(1).max(160),
  pattern: z.string().min(1).max(500).optional(),
  exact: z.boolean().optional(),
}).strict();
export type PermissionRuleInput = z.infer<typeof permissionRuleInput>;

const scope = z.enum(["user", "project"]);

export const permissionCommand = z.discriminatedUnion("action", [
  /** Allow all is only set with `confirmed: true`, which the screen sends after the person confirms in its own dialog. */
  z.object({ action: z.literal("set-mode"), mode: permissionMode, confirmed: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("add-rule"), scope, rule: permissionRuleInput }).strict(),
  z.object({ action: z.literal("remove-rule"), scope, rule: permissionRuleInput }).strict(),
  /** Confirms the allow rules this project's repository brought. */
  z.object({ action: z.literal("trust-project") }).strict(),
  z.object({ action: z.literal("revoke-trust") }).strict(),
]);
export type PermissionCommand = z.infer<typeof permissionCommand>;
export type PermissionResult = { ok: true } | { ok: false; error: string };

export type PermissionsView = {
  mode: PermissionModeId;
  rules: {
    user: PermissionRuleInput[];
    project: PermissionRuleInput[];
    trust: "not_needed" | "trusted" | "untrusted" | "changed";
    hasProject: boolean;
    problems: string[];
  };
};
