/**
 * The app's own secret check, run before anything the drafting service
 * submits is stored: patches, manifests and registration proposals.
 *
 * docs/policy/engineering-agent.md §11: a patch is stored only after two
 * independent secret checks -- the drafting service's scanner and this one --
 * and a hit is not stored at all. Only the rule id is ever recorded; the
 * matched text is not returned, logged or kept, because a secret written into
 * a record about a secret is still a leaked secret.
 *
 * Pure and dependency-free.
 */

export const ENGINEERING_AGENT_SECRET_RULES = [
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { id: "stripe-webhook-secret", pattern: /\bwhsec_[0-9A-Za-z]{16,}\b/ },
  { id: "openai-key", pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "resend-key", pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/ },
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: "connection-string-with-password",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  },
  {
    id: "authorization-bearer",
    pattern: /\bauthorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  },
  { id: "json-web-token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    /**
     * An assignment whose name says credential and whose value is not
     * obviously a placeholder.
     */
    id: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\s*[:=]\s*["']?(?!(?:your|my|the|a)[-_ ]|<|\{\{|\$\{|process\.env|xxx|todo|changeme|example|placeholder|redacted)[A-Za-z0-9._~+/=-]{12,}/i,
  },
] as const;

export type SecretRuleId = (typeof ENGINEERING_AGENT_SECRET_RULES)[number]["id"];

/**
 * The rule ids that match, in rule order, each at most once. Never the text.
 */
export const detectSecrets = (text: string): SecretRuleId[] =>
  ENGINEERING_AGENT_SECRET_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);

/** Every string field of a submission, checked together. */
export const detectSecretsInFields = (fields: Readonly<Record<string, string>>): SecretRuleId[] => {
  const found = new Set<SecretRuleId>();
  for (const value of Object.values(fields)) {
    for (const id of detectSecrets(value)) found.add(id);
  }
  return ENGINEERING_AGENT_SECRET_RULES.map((rule) => rule.id).filter((id) => found.has(id));
};
