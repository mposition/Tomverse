import "server-only";

import { createHash } from "node:crypto";

import {
  buildPolicyChangeNoticeEmail,
  POLICY_CHANGE_NOTICE_EFFECTIVE_DATE,
  type PolicyChangeNoticePayload,
} from "@/lib/emailTemplateDefinitions";

export { buildPolicyChangeNoticeEmail, POLICY_CHANGE_NOTICE_EFFECTIVE_DATE };
export type { PolicyChangeNoticePayload };

/**
 * Whether the amendment notice may be queued and sent: the owner's approval of
 * its wording, and the checks every writer and the drain ask.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md sections 10 and 12
 * (S10); docs/policy/email-policy-amendment-draft.md sections 4 and 5. The
 * wording itself is built in lib/emailTemplateDefinitions.ts.
 */

/**
 * The template versions whose wording the owner approved as the amendment
 * notice: their `contentHash` (lib/emailTemplateRegistry.ts). Empty until
 * docs/policy/email-policy-amendment-draft.md section 4 is approved.
 *
 * Two readers: the publication gate counts only deliveries of these versions,
 * and a campaign on this template is refused while its versions are not among
 * them -- so a draft wording can be neither counted as the notice nor sent as
 * one. The hash covers the whole placeholder render, links included, so it is
 * the value the production environment computes that gets listed here.
 */
export const POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES: readonly string[] = [
  // docs/policy/email-policy-amendment-draft.md §4, approved by mposition on
  // 2026-10-03, effective 2026-11-16. Rendered with production's site URL
  // (https://tomverse.app), the value production computes.
  "10f95cbc8325ebdc2b9bd76689a17f3c55cb16ec7e568369bba030fe64369e37", // en
  "f21ae3558a04d72ce633bc5bc766c1d10a16554dd2ed3be8c679fc8f9db4ee5d", // ko
  "fb30001e52b6a2a64a53ac323a7621e9fbfd3a89bce30ae84ecf76990ef84fa7", // zh
  "b63d899bffd80627008ebf9d9afb23a05e70e97c69654080a47cf5f3a9053d1f", // fr
  "85a86993fe2db189c9b6760c9d34fd3459df6307763d0b75133e9a331c8c3ee5", // de
  "18edaaf3f15216bcf72a421804a00eecc6719209279d21f95f250e50ee9767d7", // es
  "6c89e42c23482d172b5f84dd0c6c4f713d219638bfac17e8746aedc30f395691", // pt
];

/**
 * The hash the template registry takes of this render
 * (`templateContentHash()` in lib/emailTemplateRegistry.ts; a test holds the two
 * equal). Computed here so that asking whether the wording is approved needs
 * no template registry and no database.
 */
export const policyChangeNoticeRenderHash = (language: string, appUrl: string): string => {
  const rendered = buildPolicyChangeNoticeEmail({ language, appUrl });
  return createHash("sha256")
    .update(`${rendered.subject}\n${rendered.html}\n${rendered.text}`)
    .digest("hex");
};

/**
 * Whether the notice, as this build renders it in `language`, is wording the
 * owner approved: an effective date is set, and the render's hash is listed.
 *
 * Asked by every writer of a notice delivery and by the drain before it sends
 * one, so a draft wording can be neither queued nor sent -- and a deploy that
 * changes the wording stops the queue rather than sending new words under an
 * approval they never had.
 */
export const isPolicyChangeNoticeWordingApproved = (language: string, appUrl: string): boolean =>
  POLICY_CHANGE_NOTICE_EFFECTIVE_DATE !== null &&
  POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES.includes(policyChangeNoticeRenderHash(language, appUrl));
