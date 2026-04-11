interface EphemeralKey {
  apiKey: string;
  provider: string;
  expiresAt: number;
}

const keyStore = new Map<string, EphemeralKey>();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const KEY_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [compositeKey, entry] of keyStore.entries()) {
    if (entry.expiresAt <= now) {
      keyStore.delete(compositeKey);
    }
  }
}, CLEANUP_INTERVAL_MS);

function compositeKey(userId: string, provider: string): string {
  return `${userId}:${provider}`;
}

export function storeEphemeralKey(userId: string, provider: string, apiKey: string): void {
  const key = compositeKey(userId, provider);
  keyStore.set(key, {
    apiKey,
    provider,
    expiresAt: Date.now() + KEY_TTL_MS,
  });
}

export function getEphemeralKey(userId: string, provider: string): string | null {
  const key = compositeKey(userId, provider);
  const entry = keyStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    keyStore.delete(key);
    return null;
  }
  return entry.apiKey;
}

export function deleteEphemeralKey(userId: string, provider: string): void {
  keyStore.delete(compositeKey(userId, provider));
}
