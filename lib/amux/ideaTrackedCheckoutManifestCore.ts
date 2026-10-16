/** A fixed Git tree is data, not a source of filesystem paths to trust. */
export type AmuxTrackedTreeEntry = {
  path: string;
  mode: string;
  type: string;
  objectId: string;
};

export type AmuxTrackedCheckoutManifest = {
  files: Array<{ path: string; objectId: string }>;
  excluded: Array<{ path: string; reason: "secret_path" | "non_regular" }>;
};

export class AmuxTrackedCheckoutManifestError extends Error {
  readonly code = "invalid_tree";

  constructor() {
    // Git paths and object data must never enter logs or API errors.
    super("invalid_tree");
    this.name = "AmuxTrackedCheckoutManifestError";
  }
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET_BASENAME = /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.gitconfig|\.htpasswd|\.mcp\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:client[_-])?secrets?(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt|csv|local))?|credentials?(?:\.(?:json|ya?ml|toml|ini|cfg|conf|txt|csv|local))?|client_secret[^/]*\.json)$/i;
const SECRET_DIRECTORY = /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.direnv|\.claude|\.codex|\.cursor|\.gemini|\.opencode)$/i;
const SECRET_ENV_BASENAME = /^(?:\.env(?:\..+)?|\.envrc(?:\..+)?|.+\.env(?:\..+)?)$/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|crt|cer|p7b|tfstate(?:\..+)?)$/i;

const validPath = (path: string): boolean => {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." &&
    part.toLowerCase() !== ".git");
};

const secretPath = (path: string): boolean =>
  path.split("/").some((part) => SECRET_BASENAME.test(part) ||
    SECRET_DIRECTORY.test(part) || SECRET_ENV_BASENAME.test(part) ||
    SECRET_EXTENSION.test(part));

/**
 * Plan a read-only checkout from an already pinned, recursively listed Git
 * tree. A later materializer must use only `files` and must still scan their
 * complete contents before exposing the checkout to a model CLI.
 */
export function planAmuxTrackedCheckout(
  entries: Iterable<AmuxTrackedTreeEntry>,
): AmuxTrackedCheckoutManifest {
  const files: AmuxTrackedCheckoutManifest["files"] = [];
  const excluded: AmuxTrackedCheckoutManifest["excluded"] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || !validPath(entry.path) ||
        typeof entry.objectId !== "string" || !OBJECT_ID.test(entry.objectId) ||
        typeof entry.mode !== "string" || typeof entry.type !== "string" ||
        seen.has(entry.path)) {
      throw new AmuxTrackedCheckoutManifestError();
    }
    seen.add(entry.path);
    if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
      if (secretPath(entry.path)) excluded.push({ path: entry.path, reason: "secret_path" });
      else files.push({ path: entry.path, objectId: entry.objectId });
    } else if ((entry.type === "blob" && entry.mode === "120000") ||
               (entry.type === "commit" && entry.mode === "160000")) {
      excluded.push({ path: entry.path, reason: secretPath(entry.path) ? "secret_path" : "non_regular" });
    } else {
      throw new AmuxTrackedCheckoutManifestError();
    }
  }

  for (const path of seen) {
    let slash = path.indexOf("/");
    while (slash !== -1) {
      if (seen.has(path.slice(0, slash))) throw new AmuxTrackedCheckoutManifestError();
      slash = path.indexOf("/", slash + 1);
    }
  }
  const comparePath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  files.sort(comparePath);
  excluded.sort(comparePath);
  return { files, excluded };
}
