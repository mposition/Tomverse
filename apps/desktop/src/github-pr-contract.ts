import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const fields = z.object({ url: z.string().trim().max(240), environment: z.string().trim().max(80) }).strict();
export const pullLink = fields.superRefine(({ url }, context) => {
  if (!githubPullUrl(url)) context.addIssue({ code: "custom", path: ["url"], message: "Invalid GitHub pull request URL" });
});
export const pullEvidence = fields.extend({
  checkedAt: z.number().int().nonnegative(),
  head: sha.optional(),
  merge: sha.optional(),
  conflict: z.boolean().optional(),
  state: z.enum(["unknown", "unavailable", "pending", "closed", "failed", "conflict", "passed", "merged", "deploy_failed", "deploy_pending", "deployed"]),
}).strict();
export type PullEvidence = z.infer<typeof pullEvidence>;
export type PullLink = z.infer<typeof pullLink>;
export const taskPullCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.enum(["read", "open"]), link: pullLink }).strict(),
]);

export function githubPullUrl(url: string) {
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9-]{1,39})\/([a-zA-Z0-9_.-]{1,100})\/pull\/([1-9]\d{0,11})\/?$/.exec(url.trim());
  if (!match || match[2] === "." || match[2] === "..") return null;
  const repo = match[1] + "/" + match[2];
  return { repo, number: Number(match[3]), url: "https://github.com/" + repo + "/pull/" + match[3] };
}
