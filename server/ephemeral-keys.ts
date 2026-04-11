import crypto from "crypto";
import { storage } from "./storage";

interface EphemeralKeyEntry {
  apiKey: string;
  provider: string;
  expiresAt: number;
}

const keyStore = new Map<string, EphemeralKeyEntry>();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const KEY_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [compositeKey, entry] of keyStore.entries()) {
    if (entry.expiresAt <= now) {
      keyStore.delete(compositeKey);
    }
  }
  storage.deleteExpiredApiKeys().catch(err => {
    console.error("Failed to clean expired API key records:", err);
  });
}, CLEANUP_INTERVAL_MS);

function makeCompositeKey(userId: string, provider: string): string {
  return `${userId}:${provider}`;
}

function hashKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").substring(0, 16);
}

export async function storeEphemeralKey(userId: string, provider: string, apiKey: string): Promise<void> {
  const key = makeCompositeKey(userId, provider);
  const expiresAt = Date.now() + KEY_TTL_MS;
  keyStore.set(key, { apiKey, provider, expiresAt });

  const keyHashValue = hashKey(apiKey);
  await storage.storeUserApiKeyRecord(userId, provider, keyHashValue, new Date(expiresAt));
}

export function getEphemeralKey(userId: string, provider: string): string | null {
  const key = makeCompositeKey(userId, provider);
  const entry = keyStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    keyStore.delete(key);
    return null;
  }
  return entry.apiKey;
}

export function deleteEphemeralKey(userId: string, provider: string): void {
  keyStore.delete(makeCompositeKey(userId, provider));
}
