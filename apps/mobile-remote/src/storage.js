import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@codebuddy/mobile-remote/hosts';

/**
 * Load paired hosts from persistent storage. Always async — RN has no sync
 * storage API. Returns [] on missing/corrupt.
 */
export async function loadHostsAsync() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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