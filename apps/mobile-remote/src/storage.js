import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@codebuddy/mobile-remote/hosts';
// C1: persistent per-device Ed25519 keypair used to authenticate every
// mobile-remote connection. Generated on first pair, kept across sessions.
const DEVICE_KEY = '@codebuddy/mobile-remote/device-key';

/**
 * Load paired hosts from persistent storage. Always async — RN has no sync
 * storage API. Returns [] on missing/corrupt. Sanitizes legacy host records
 * that may still carry a `deviceSecretKeyB64` field (private keys must never
 * live in the host list — they belong only in DEVICE_KEY storage).
 */
export async function loadHostsAsync() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let dirty = false;
    const cleaned = parsed.map((h) => {
      if (h && Object.prototype.hasOwnProperty.call(h, 'deviceSecretKeyB64')) {
        dirty = true;
        const { deviceSecretKeyB64, ...rest } = h;
        return rest;
      }
      return h;
    });
    if (dirty) {
      try { await AsyncStorage.setItem(KEY, JSON.stringify(cleaned)); } catch { /* ignore */ }
    }
    return cleaned;
  } catch {
    return [];
  }
}

export async function saveHosts(hosts) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(hosts));
  } catch {
    /* ignore */
  }
}

/**
 * @returns {Promise<{ publicKeyB64: string, secretKeyB64: string } | null>}
 */
export async function loadDeviceKey() {
  try {
    const raw = await AsyncStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.publicKeyB64 === 'string' && typeof parsed.secretKeyB64 === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveDeviceKey(key) {
  try {
    await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify(key));
  } catch {
    /* ignore */
  }
}