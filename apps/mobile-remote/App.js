// MUST be first: polyfills globalThis.crypto.getRandomValues on RN before any
// tweetnacl call (the crypto package's ensurePrng falls back to it).
import 'react-native-get-random-values';

import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import { useEffect, useState } from 'react';

import PairScreen from './src/PairScreen';
import HostScreen from './src/HostScreen';
import { loadHostsAsync, saveHosts } from './src/storage';

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

  const addHost = (host) => {
    setHosts((prev) => {
      const next = [...prev.filter((h) => h.serverId !== host.serverId), host];
      void saveHosts(next);
      return next;
    });
    setActiveHost(host);
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