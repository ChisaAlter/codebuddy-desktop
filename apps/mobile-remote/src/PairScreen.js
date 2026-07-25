import { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  TouchableOpacity,
  FlatList,
  Alert,
  Modal,
  Pressable,
} from 'react-native';
// expo-camera ~15.0.0 exports Camera (legacy) with onBarCodeScanned / barCodeTypes.
// (Newer SDKs renamed to CameraView + onBarcodeScanned / barcodeScannerSettings.)
import { Camera } from 'expo-camera';

import { parseConnectionOfferFromUrl } from '@codebuddy/mobile-remote-protocol';

export default function PairScreen({ hosts, loaded, onPair, onSelect, onRemove }) {
  const [pasted, setPasted] = useState('');
  const [scanning, setScanning] = useState(false);
  const [camPermission, setCamPermission] = useState(null);

  const tryPair = (text, sourceLabel) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    let offer;
    try {
      offer = parseConnectionOfferFromUrl(trimmed);
    } catch (err) {
      Alert.alert('配对失败', `${sourceLabel}: ${err?.message || '无法解析配对链接'}`);
      return;
    }
    if (!offer) {
      Alert.alert('配对失败', `${sourceLabel}: 链接里没有 #offer= 片段`);
      return;
    }
    onPair({
      serverId: offer.serverId,
      hostPublicKeyB64: offer.hostPublicKeyB64,
      relay: offer.relay,
      label: `Host ${offer.serverId.slice(0, 8)}`,
      addedAt: Date.now(),
    });
    setPasted('');
    setScanning(false);
  };

  const handlePaste = () => tryPair(pasted, '粘贴');

  const openScanner = async () => {
    // Request camera permission (expo-camera exposes Camera.requestCameraPermissionsAsync).
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setCamPermission(status);
      if (status !== 'granted') {
        Alert.alert('无相机权限', '请在系统设置中允许相机以扫码配对');
        return;
      }
      setScanning(true);
    } catch (err) {
      Alert.alert('相机不可用', err?.message || String(err));
    }
  };

  const handleBarCodeScanned = ({ data }) => {
    // expo-camera 15.x: fires onBarCodeScanned with { data, type }.
    setScanning(false);
    tryPair(data, '扫码');
  };

  const renderItem = ({ item }) => (
    <View style={styles.hostRow}>
      <TouchableOpacity style={styles.hostInfo} onPress={() => onSelect(item)}>
        <Text style={styles.hostLabel}>{item.label}</Text>
        <Text style={styles.hostSub}>{item.relay.endpoint}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onRemove(item.serverId)}>
        <Text style={styles.remove}>移除</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>CodeBuddy 手机远程</Text>
      <Text style={styles.subtitle}>扫码或粘贴 Desktop 显示的配对链接</Text>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.scanBtn} onPress={openScanner}>
          <Text style={styles.btnText}>扫码配对</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.hint}>或粘贴链接：</Text>
      <TextInput
        style={styles.input}
        placeholder="codebuddy-remote://pair#offer=..."
        placeholderTextColor="#6e7681"
        value={pasted}
        onChangeText={setPasted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity style={styles.btn} onPress={handlePaste}>
        <Text style={styles.btnText}>配对</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>已配对主机</Text>
      {!loaded ? (
        <Text style={styles.empty}>加载中…</Text>
      ) : (
        <FlatList
          data={hosts}
          keyExtractor={(h) => h.serverId}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={styles.empty}>暂无主机，请先配对。</Text>}
        />
      )}

      <Modal visible={scanning} transparent animationType="slide" onRequestClose={() => setScanning(false)}>
        <Pressable style={styles.camOverlay} onPress={() => setScanning(false)}>
          <View style={styles.camSheet}>
            <Text style={styles.camTitle}>扫描配对二维码</Text>
            {camPermission === 'granted' ? (
              <Camera
                style={styles.camera}
                onBarCodeScanned={handleBarCodeScanned}
                barCodeTypes={['qr']}
                ratio="16:9"
              />
            ) : (
              <Text style={styles.empty}>相机权限未授予</Text>
            )}
            <TouchableOpacity style={styles.btn} onPress={() => setScanning(false)}>
              <Text style={styles.btnText}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { color: '#e6edf3', fontSize: 22, fontWeight: '600', marginTop: 8 },
  subtitle: { color: '#8b949e', fontSize: 13, marginTop: 4, marginBottom: 16 },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  scanBtn: { backgroundColor: '#238636', padding: 12, borderRadius: 8, alignItems: 'center', flex: 1 },
  btn: { backgroundColor: '#2f81f7', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  btnText: { color: '#fff', fontWeight: '600' },
  hint: { color: '#6e7681', fontSize: 12, marginTop: 12, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    padding: 12,
    color: '#e6edf3',
    fontSize: 13,
  },
  sectionTitle: { color: '#8b949e', fontSize: 12, marginTop: 24, marginBottom: 8 },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: '#21262d',
  },
  hostInfo: { flex: 1 },
  hostLabel: { color: '#e6edf3', fontSize: 15 },
  hostSub: { color: '#6e7681', fontSize: 12, marginTop: 2 },
  remove: { color: '#f85149', fontSize: 13 },
  empty: { color: '#6e7681', fontSize: 13, textAlign: 'center', marginTop: 24 },
  camOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
  camSheet: { backgroundColor: '#0d1117', borderRadius: 12, padding: 16, width: '88%', alignItems: 'center' },
  camTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '600', marginBottom: 12 },
  camera: { width: '100%', aspectRatio: 1, borderRadius: 8, overflow: 'hidden' },
});