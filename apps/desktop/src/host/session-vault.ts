import { lstat, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "../../../tomverse-cli/src/session";

const secretSession = z.object({
  accountId: z.string().min(1).max(128),
  accessToken: z.string().min(1).max(8_192),
  refreshToken: z.string().min(1).max(512).optional(),
  expiresAt: z.number().int().positive(),
}).strict();

export type StoredDesktopSession = z.infer<typeof secretSession>;
const secretCodeKey = z.object({ accountId: z.string().min(1).max(128), key: z.string().min(1).max(160) }).strict();
export type StorageMode = "device" | "session";
type SafeStoragePort = Pick<Electron.SafeStorage,
  "isAsyncEncryptionAvailable" | "encryptStringAsync" | "decryptStringAsync" |
  "getSelectedStorageBackend" | "isEncryptionAvailable" | "encryptString" | "decryptString">;

const strongLinuxBackend = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
const hasLinuxKeyringCipher = (ciphertext: Buffer) => ciphertext.subarray(0, 3).toString("ascii") === "v11";

function createEncryptedVault<T>(path: string, storage: SafeStoragePort, platform: NodeJS.Platform,
  schema: z.ZodType<T>, isReadable: (value: T) => boolean,
) {
  // Electron 45's asynchronous Linux fallback does not expose the chosen key
  // provider. The pinned synchronous format lets us require a keyring ciphertext.
  async function encryptionAvailable() {
    if (platform === "linux") {
      return strongLinuxBackend.has(storage.getSelectedStorageBackend()) && storage.isEncryptionAvailable();
    }
    return storage.isAsyncEncryptionAvailable();
  }

  async function save(value: T, signal?: AbortSignal): Promise<StorageMode> {
    try {
      if (!(await encryptionAvailable())) return "session";
      const plain = JSON.stringify(schema.parse(value));
      const encrypted = platform === "linux" ? storage.encryptString(plain) : await storage.encryptStringAsync(plain);
      if (!encrypted.length || (platform === "linux" && !hasLinuxKeyringCipher(encrypted))) return "session";
      signal?.throwIfAborted();
      writeFileAtomic(path, encrypted);
      return "device";
    } catch {
      return "session";
    }
  }

  async function read(): Promise<T | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size < 1 || info.size > 16_384 || !(await encryptionAvailable())) return null;
      const encrypted = await readFile(path);
      if (platform === "linux" && !hasLinuxKeyringCipher(encrypted)) return null;
      const decoded = platform === "linux"
        ? { result: storage.decryptString(encrypted), shouldReEncrypt: false }
        : await storage.decryptStringAsync(encrypted);
      const parsed = schema.parse(JSON.parse(decoded.result));
      if (!isReadable(parsed)) return null;
      if (decoded.shouldReEncrypt) await save(parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  return {
    read,
    save,
    async clear() {
      try { await unlink(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export const createSessionVault = (path: string, storage: SafeStoragePort, platform: NodeJS.Platform) =>
  createEncryptedVault(path, storage, platform, secretSession, (value) => value.expiresAt > Date.now() || Boolean(value.refreshToken));

export const createCodeKeyVault = (path: string, storage: SafeStoragePort, platform: NodeJS.Platform, accountId: string) =>
  createEncryptedVault(path, storage, platform, secretCodeKey, (value) => value.accountId === accountId);
