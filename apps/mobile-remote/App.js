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
  // C1: the device secret key is held in App-level state, sourced from the
  // global DEVICE_KEY storage. It is NOT persisted into the host list (which
  // is plain JSON on disk) — only deviceId + devicePublicKeyB64 travel with
  // each host record. HostScreen receives the secret via props at render time.
  const [deviceSecretKeyB64, setDeviceSecretKeyB64] = useState(null);
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

  // C1: load the device secret key into App state once on mount so it can be
  // passed to HostScreen as a prop without ever being written into the host
  // list. Regenerated lazily by ensureDeviceKey during addHost if absent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = await loadDeviceKey();
      if (cancelled) return;
      if (key?.secretKeyB64) setDeviceSecretKeyB64(key.secretKeyB64);
    })();
    return () => { cancelled = true; };
  }, []);

  const addHost = async (host) => {
    // C1: attach the deviceId + devicePublicKey to the host entry so HostScreen
    // can build the device-auth challenge. The secret key is deliberately NOT
    // stored in the host record — it stays only in global DEVICE_KEY storage
    // and is passed to HostScreen via the `deviceSecretKeyB64` prop below.
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
    if (device) setDeviceSecretKeyB64(device.secretKeyB64);
    const enriched = device
      ? { ...host, deviceId: device.deviceId, devicePublicKeyB64: device.publicKeyB64 }
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
        <HostScreen host={activeHost} deviceSecretKeyB64={deviceSecretKeyB64} onLeave={() => setActiveHost(null)} />
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