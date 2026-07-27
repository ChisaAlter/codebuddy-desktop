// MUST be first: polyfills globalThis.crypto.getRandomValues on RN before any
// tweetnacl call (the crypto package's ensurePrng falls back to it).
import 'react-native-get-random-values';

import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import { useEffect, useState } from 'react';

import PairScreen from './src/PairScreen';
import HostScreen from './src/HostScreen';
import { loadHostsAsync, saveHosts, loadDeviceKey, saveDeviceKey } from './src/storage';
import { generateDeviceKeyPair, exportDevicePublicKey, exportDeviceSecretKey, importDevicePublicKey, deriveDeviceId } from '@codebuddy/mobile-remote-crypto';

export default function App() {
  // Sync [] as initial value; real persisted hosts load async on mount.
  const [hosts, setHosts] = useState([]);
  const [activeHost, setActiveHost] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadHostsAsync();
      if (cancelled) return;
      setHosts(stored);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // C1: ensure a persistent device keypair exists (generated on first pair,
  // reused across hosts/sessions). The deviceId is derived from the public key
  // so it is stable and unforgeable.
  const ensureDeviceKey = async () => {
    let key = await loadDeviceKey();
    if (!key) {
      const kp = generateDeviceKeyPair();
      key = {
        publicKeyB64: exportDevicePublicKey(kp.publicKey),
        secretKeyB64: exportDeviceSecretKey(kp.secretKey),
      };
      await saveDeviceKey(key);
    }
    const deviceId = deriveDeviceId(importDevicePublicKey(key.publicKeyB64));
    return { ...key, deviceId };
  };

  const addHost = async (host) => {
    // C1: attach the device key + deviceId to the host entry so HostScreen can
    // sign per-connection device-auth challenges.
    let device = null;
    try {
      device = await ensureDeviceKey();
    } catch (err) {
      // If device key generation fails (e.g. PRNG unavailable), fall back to the
      // legacy random deviceId so pairing still works (auth will fail at the host
      // until a re-pair with a real key). Surface nothing to the user for now.
      // eslint-disable-next-line no-console
      console.warn('device key generation failed', err?.message || err);
    }
    const enriched = device
      ? { ...host, deviceId: device.deviceId, devicePublicKeyB64: device.publicKeyB64, deviceSecretKeyB64: device.secretKeyB64 }
      : host;
    setHosts((prev) => {
      const next = [...prev.filter((h) => h.serverId !== host.serverId), enriched];
      void saveHosts(next);
      return next;
    });
    setActiveHost(enriched);
  };

  const removeHost = (serverId) => {
    setHosts((prev) => {
      const next = prev.filter((h) => h.serverId !== serverId);
      void saveHosts(next);
      return next;
    });
    setActiveHost((cur) => (cur?.serverId === serverId ? null : cur));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      {activeHost ? (
        <HostScreen host={activeHost} onLeave={() => setActiveHost(null)} />
      ) : (
        <PairScreen
          hosts={hosts}
          loaded={loaded}
          onPair={addHost}
          onSelect={setActiveHost}
          onRemove={removeHost}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d1117' },
});