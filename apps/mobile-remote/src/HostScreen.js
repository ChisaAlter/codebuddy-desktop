import { useEffect, useRef, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Modal,
  Pressable,
  Alert,
} from 'react-native';

import {
  buildRelayWebSocketUrl,
  Ops,
} from '@codebuddy/mobile-remote-protocol';
import {
  importPublicKey,
  createClientChannel,
  parseHandshakeMessage,
  buildE2eeHelloMessage,
  importDeviceSecretKey,
  signDeviceAuth,
  deriveDeviceId,
  importDevicePublicKey,
} from '@codebuddy/mobile-remote-crypto';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const THOUGHT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'disabled', 'enabled'];
const MODE_PRESETS = [
  { id: 'default', label: '默认' },
  { id: 'plan', label: '规划' },
  { id: 'accept_edits', label: '自动接受' },
  { id: 'bypass_permissions', label: '跳过权限' },
];

export default function HostScreen({ host, onLeave }) {
  const [status, setStatus] = useState('connecting');
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedThread, setSelectedThread] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sessionOptions, setSessionOptions] = useState({ model: null, mode: null, reasoning: null });
  const [models, setModels] = useState([]);
  const [pendingPermissions, setPendingPermissions] = useState([]);
  const [bgTasks, setBgTasks] = useState([]);
  const [showBgTasks, setShowBgTasks] = useState(false);
  const [showComposerSheet, setShowComposerSheet] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState(false);

  const wsRef = useRef(null);
  const channelRef = useRef(null);
  const readyRef = useRef(false);
  // C1: the relay-assigned connectionId, received from the host's encrypted
  // 'connected' message right after e2ee_ready. Used to sign the device-auth
  // challenge so the signature is bound to this connection (anti-replay).
  const connectionIdRef = useRef(null);
  // C1: set true once a device_pair/device_auth succeeds; gates privileged ops.
  const authedRef = useRef(false);
  // C1: set true once we've attempted device_pair (so an auth_required after that
  // is a real failure, not a "first-time, try pairing instead" signal).
  const pairAttemptedRef = useRef(false);
  const opSeq = useRef(0);
  const activeRunId = useRef(null);
  const reconnectTimer = useRef(null);
  const attemptRef = useRef(0);
  const closedByUserRef = useRef(false);
  // C1: deviceId and device secret key come from the host entry (set by App.js
  // from the persistent per-device Ed25519 keypair). Falling back to a random id
  // only when the host entry lacks a device key (legacy/failed-key-generation).
  const deviceIdRef = useRef(
    host.deviceId || (host.devicePublicKeyB64 ? deriveDeviceId(importDevicePublicKey(host.devicePublicKeyB64)) : `dev-${Math.random().toString(36).slice(2, 10)}`),
  );

  const connect = useCallback(() => {
    if (closedByUserRef.current) return;
    const hostPub = importPublicKey(host.hostPublicKeyB64);
    const { ephemeralPublicKeyB64, channel } = createClientChannel(hostPub);
    channelRef.current = channel;

    const url = buildRelayWebSocketUrl({
      endpoint: host.relay.endpoint,
      useTls: host.relay.useTls !== false,
      serverId: host.serverId,
      role: 'client',
      connectionId: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('handshaking');
      ws.send(buildE2eeHelloMessage(ephemeralPublicKeyB64));
    };

    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      if (!readyRef.current) {
        const msg = parseHandshakeMessage(text);
        if (msg?.type === 'e2ee_ready') {
          readyRef.current = true;
          setStatus('authenticating');
          attemptRef.current = 0;
          // Wait for the host's encrypted 'connected' message (carries the
          // relay-assigned connectionId) before sending the device-auth challenge.
        }
        return;
      }
      let plain;
      try { plain = channel.decryptUtf8(text); } catch { return; }
      let msg;
      try { msg = JSON.parse(plain); } catch { return; }
      // C1: the host sends 'connected' first with the connectionId we must sign.
      if (msg.type === 'connected' && msg.connectionId && !authedRef.current) {
        connectionIdRef.current = msg.connectionId;
        authenticateDevice(msg.serverId || host.serverId);
        return;
      }
      handleServerMessage(msg);
    };

    ws.onerror = () => {
      setStatus('error');
      setError('连接错误');
    };
    ws.onclose = () => {
      readyRef.current = false;
      wsRef.current = null;
      if (closedByUserRef.current) return;
      setStatus('reconnecting');
      const attempt = ++attemptRef.current;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    };
  }, [host.serverId, host.relay.endpoint, host.relay.useTls]);

  useEffect(() => {
    closedByUserRef.current = false;
    connect();
    return () => {
      closedByUserRef.current = true;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      readyRef.current = false;
    };
  }, [connect]);

  function sendOp(op) {
    if (!wsRef.current || !readyRef.current || !channelRef.current) return null;
    const id = `op-${++opSeq.current}`;
    const withId = { ...op, id };
    const bundle = channelRef.current.encrypt(JSON.stringify(withId));
    try { wsRef.current.send(bundle); } catch { return null; }
    return id;
  }

  // C1: sign the device-auth challenge { serverId, deviceId, connectionId, issuedAt }
  // with the persistent device secret key and send device_auth. Falls back to
  // device_pair on the host's auth_required (first-time pairing).
  const authenticateDevice = (serverId) => {
    if (!host.deviceSecretKeyB64) {
      // No persistent device key → try first-time pairing directly.
      pairAttemptedRef.current = true;
      sendDevicePair();
      return;
    }
    const issuedAt = Date.now();
    let sig;
    try {
      sig = signDeviceAuth(
        { serverId, deviceId: deviceIdRef.current, connectionId: connectionIdRef.current, issuedAt },
        importDeviceSecretKey(host.deviceSecretKeyB64),
      );
    } catch (err) {
      setStatus('error');
      setError(`设备密钥签名失败：${err?.message || err}`);
      return;
    }
    sendOp({
      type: 'device_auth',
      deviceId: deviceIdRef.current,
      signedChallenge: sig,
      issuedAt,
    });
  };

  const sendDevicePair = () => {
    if (!host.deviceSecretKeyB64 || !host.devicePublicKeyB64) {
      setStatus('error');
      setError('缺少设备密钥，无法配对');
      return;
    }
    const issuedAt = Date.now();
    let sig;
    try {
      sig = signDeviceAuth(
        { serverId: host.serverId, deviceId: deviceIdRef.current, connectionId: connectionIdRef.current, issuedAt },
        importDeviceSecretKey(host.deviceSecretKeyB64),
      );
    } catch (err) {
      setStatus('error');
      setError(`设备密钥签名失败：${err?.message || err}`);
      return;
    }
    sendOp({
      type: 'device_pair',
      publicKeyB64: host.devicePublicKeyB64,
      label: `Android-${deviceIdRef.current.slice(4, 10)}`,
      signedChallenge: sig,
      issuedAt,
      pairingToken: host.pairingToken || null,
    });
  };

  const handleServerMessage = useCallback((msg) => {
    if (!msg) return;
    switch (msg.type) {
      // C1: device_auth success → connection is now privileged; request projects.
      case 'device_auth_ack':
        authedRef.current = true;
        setDeviceRegistered(true);
        setStatus('ready');
        sendOp({ type: Ops.LIST_PROJECTS });
        break;
      // C1: device_pair success → first-time pairing established; request projects.
      case 'device_paired':
        authedRef.current = true;
        deviceIdRef.current = msg.deviceId || deviceIdRef.current;
        setDeviceRegistered(true);
        setStatus('ready');
        sendOp({ type: Ops.LIST_PROJECTS });
        break;
      // C1: auth required / pair failed. If we tried device_auth and the host
      // doesn't know this device, retry with device_pair (first-time pair). If
      // device_pair failed, surface the error.
      case 'auth_required':
        if (!authedRef.current && !pairAttemptedRef.current) {
          pairAttemptedRef.current = true;
          sendDevicePair();
        } else {
          setStatus('error');
          setError(`鉴权失败：${msg.error || 'unknown'}`);
        }
        break;
      case 'device_registered':
        setDeviceRegistered(true);
        break;
      case 'projects':
        setProjects(msg.projects || []);
        break;
      case 'threads':
        setThreads(msg.threads || []);
        break;
      case 'thread_opened':
        setTimeline(msg.timeline || []);
        // fetch current session options + models
        if (selectedProject) {
          sendOp({ type: Ops.GET_SESSION_OPTIONS, projectId: selectedProject.projectId, threadId: msg.threadId || selectedThread?.threadId });
          sendOp({ type: Ops.LIST_MODELS, projectId: selectedProject.projectId });
        }
        break;
      case 'session_options':
        setSessionOptions({ model: msg.model, mode: msg.mode, reasoning: msg.reasoning });
        break;
      case 'models':
        if (msg.ok && Array.isArray(msg.models)) setModels(msg.models.map((m) => ({ id: m.id || m, name: m.name || m.id || m })));
        break;
      case 'setting_applied':
        if (msg.ok) {
          setSessionOptions((prev) => ({
            ...prev,
            model: msg.kind === 'set_model' ? msg.value : prev.model,
            mode: msg.kind === 'set_mode' ? msg.value : prev.mode,
            reasoning: msg.kind === 'set_reasoning' ? msg.value : prev.reasoning,
          }));
        } else {
          setError(msg.error || '设置失败');
        }
        break;
      case 'prompt_started':
        activeRunId.current = msg.runId;
        setBusy(true);
        setError('');
        break;
      case 'stream_event':
        setTimeline((prev) => [...prev, msg.event]);
        // surface permission_request events
        if (msg.event?.type === 'permission_request' || msg.event?.method === 'permission_request') {
          const req = msg.event?.params || msg.event;
          if (req?.requestId) {
            setPendingPermissions((prev) => [...prev, { ...req, projectId: msg.projectId, threadId: msg.threadId }]);
          }
        }
        break;
      case 'prompt_done':
        setBusy(false);
        activeRunId.current = null;
        if (msg.error) setError(msg.error.message || 'prompt 失败');
        break;
      case 'interrupted':
        setBusy(false);
        activeRunId.current = null;
        break;
      case 'permission_response_ack':
        setPendingPermissions((prev) => prev.filter((p) => p.requestId !== msg.requestId));
        break;
      case 'background_tasks':
        setBgTasks(msg.tasks || []);
        break;
      case 'notify':
        // In-connection notification: best-effort local alert (no FCM in MVP).
        Alert.alert(msg.title || 'CodeBuddy', msg.body || '');
        break;
      case 'error':
        setError(`${msg.code || 'error'}: ${msg.message || ''}`);
        break;
      case 'pong':
      case 'devices':
      case 'device_revoked':
      default:
        break;
    }
  }, [selectedProject, selectedThread]);

  // ---- actions ----
  const openProject = (p) => {
    setSelectedProject(p);
    setSelectedThread(null);
    setTimeline([]);
    sendOp({ type: Ops.ENSURE_RUNTIME, projectId: p.projectId });
    sendOp({ type: Ops.LIST_THREADS, projectId: p.projectId });
    sendOp({ type: Ops.LIST_BACKGROUND_TASKS });
  };

  const openThread = (t) => {
    setSelectedThread(t);
    setTimeline([]);
    setPendingPermissions([]);
    sendOp({ type: Ops.OPEN_THREAD, projectId: selectedProject.projectId, threadId: t.threadId });
  };

  const sendPrompt = () => {
    if (!selectedProject || !selectedThread || !draft.trim() || busy) return;
    const text = draft.trim();
    setDraft('');
    setTimeline((prev) => [...prev, { role: 'user', content: text }]);
    sendOp({
      type: Ops.PROMPT,
      projectId: selectedProject.projectId,
      threadId: selectedThread.threadId,
      text,
    });
  };

  const interrupt = () => {
    if (activeRunId.current) sendOp({ type: Ops.INTERRUPT, runId: activeRunId.current });
  };

  const setModel = (modelId) => {
    if (!selectedProject || !selectedThread) return;
    sendOp({ type: Ops.SET_MODEL, projectId: selectedProject.projectId, threadId: selectedThread.threadId, modelId });
    setShowComposerSheet(false);
  };
  const setMode = (modeId) => {
    if (!selectedProject || !selectedThread) return;
    sendOp({ type: Ops.SET_MODE, projectId: selectedProject.projectId, threadId: selectedThread.threadId, modeId });
    setShowComposerSheet(false);
  };
  const setReasoning = (value) => {
    if (!selectedProject || !selectedThread) return;
    sendOp({ type: Ops.SET_REASONING, projectId: selectedProject.projectId, threadId: selectedThread.threadId, value });
    setShowComposerSheet(false);
  };

  const respondPermission = (req, decision) => {
    sendOp({
      type: Ops.PERMISSION_RESPOND,
      projectId: req.projectId,
      threadId: req.threadId,
      requestId: req.requestId,
      decision,
    });
  };

  // ---- render ----
  if (status === 'connecting' || status === 'handshaking') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#2f81f7" />
        <Text style={styles.muted}>{status === 'handshaking' ? '加密握手中…' : '连接中…'}</Text>
      </View>
    );
  }
  if (status === 'reconnecting') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#d29922" />
        <Text style={styles.muted}>主机/中继离线，自动重连中…</Text>
        <TouchableOpacity style={styles.btn} onPress={onLeave}>
          <Text style={styles.btnText}>返回</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (status === 'error' && !wsRef.current) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error || '连接失败'}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => { attemptRef.current = 0; connect(); }}>
          <Text style={styles.btnText}>重试</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnGhost} onPress={onLeave}>
          <Text style={styles.btnText}>返回</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!selectedProject) {
    return (
      <View style={styles.container}>
        <Header title="项目列表" onBack={onLeave} right={
          <TouchableOpacity onPress={() => sendOp({ type: Ops.LIST_BACKGROUND_TASKS }) || setShowBgTasks(true)}>
            <Text style={styles.back}>任务</Text>
          </TouchableOpacity>
        } />
        <FlatList
          data={projects}
          keyExtractor={(p) => p.projectId}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => openProject(item)}>
              <Text style={styles.rowTitle}>{item.name || item.projectId}</Text>
              <Text style={styles.rowSub}>{item.cwd || ''}</Text>
              <Text style={styles.rowSub}>{item.runtimeStatus}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.empty}>暂无项目</Text>}
        />
        <BackgroundTasksModal visible={showBgTasks} tasks={bgTasks} onClose={() => setShowBgTasks(false)} />
      </View>
    );
  }

  if (!selectedThread) {
    return (
      <View style={styles.container}>
        <Header title={selectedProject.name || selectedProject.projectId} onBack={() => setSelectedProject(null)} />
        <FlatList
          data={threads}
          keyExtractor={(t) => t.threadId}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => openThread(item)}>
              <Text style={styles.rowTitle}>{item.title || item.threadId}</Text>
              <Text style={styles.rowSub}>{item.archived ? '已归档' : '活跃'}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.empty}>暂无会话（请在桌面端创建）</Text>}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Header
        title={selectedThread.title || selectedThread.threadId}
        onBack={() => setSelectedThread(null)}
        right={
          <TouchableOpacity onPress={() => setShowComposerSheet(true)}>
            <Text style={styles.back}>设置</Text>
          </TouchableOpacity>
        }
      />

      <FlatList
        data={timeline}
        keyExtractor={(item, idx) => String(idx)}
        renderItem={({ item }) => <TimelineItem item={item} />}
        ListEmptyComponent={<Text style={styles.empty}>开始对话…</Text>}
      />

      {pendingPermissions.length > 0 ? (
        <View style={styles.permBar}>
          {pendingPermissions.slice(0, 1).map((req) => (
            <View key={req.requestId} style={styles.permCard}>
              <Text style={styles.permTitle} numberOfLines={2}>
                权限请求: {req.toolName || req.tool || '工具调用'}
              </Text>
              <Text style={styles.permDesc} numberOfLines={3}>{req.description || req.summary || ''}</Text>
              <View style={styles.permActions}>
                <TouchableOpacity style={styles.permDeny} onPress={() => respondPermission(req, 'deny')}>
                  <Text style={styles.btnText}>拒绝</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.permAllow} onPress={() => respondPermission(req, 'allow')}>
                  <Text style={styles.btnText}>允许</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.composer}>
        <TouchableOpacity style={styles.composerMeta} onPress={() => setShowComposerSheet(true)}>
          <Text style={styles.metaLabel} numberOfLines={1}>
            {sessionOptions.model || '模型'} · {sessionOptions.mode || '模式'} · {sessionOptions.reasoning || '思考'}
          </Text>
        </TouchableOpacity>
        <View style={styles.composerRow}>
          <TextInput
            style={styles.input}
            placeholder="发消息…"
            placeholderTextColor="#6e7681"
            value={draft}
            onChangeText={setDraft}
            editable={!busy}
            multiline
          />
          {busy ? (
            <TouchableOpacity style={styles.stopBtn} onPress={interrupt}>
              <Text style={styles.btnText}>停止</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sendBtn} onPress={sendPrompt} disabled={!draft.trim()}>
              <Text style={styles.btnText}>发送</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ComposerSheet
        visible={showComposerSheet}
        onClose={() => setShowComposerSheet(false)}
        sessionOptions={sessionOptions}
        models={models}
        onSetModel={setModel}
        onSetMode={setMode}
        onSetReasoning={setReasoning}
      />
    </View>
  );
}

function Header({ title, onBack, right }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.back}>‹ 返回</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      {right || <View />}
    </View>
  );
}

function TimelineItem({ item }) {
  const isUser = item.role === 'user';
  const text =
    item.content ||
    item.raw?.content?.text ||
    item.text ||
    (item.type ? `[${item.type}]` : JSON.stringify(item).slice(0, 200));
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
      <Text style={styles.bubbleText}>{text}</Text>
    </View>
  );
}

function BackgroundTasksModal({ visible, tasks, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>后台任务</Text>
          <FlatList
            data={tasks}
            keyExtractor={(t, i) => t.pid?.toString() || String(i)}
            renderItem={({ item }) => (
              <View style={styles.taskRow}>
                <Text style={styles.taskTitle}>{item.name || item.pid || 'task'}</Text>
                <Text style={styles.taskSub}>{item.status || ''} {item.endpoint ? `· ${item.endpoint}` : ''}</Text>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>暂无后台任务</Text>}
          />
          <TouchableOpacity style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>关闭</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

function ComposerSheet({ visible, onClose, sessionOptions, models, onSetModel, onSetMode, onSetReasoning }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>会话设置</Text>

          <Text style={styles.sheetLabel}>模型</Text>
          <View style={styles.chipRow}>
            {models.length ? models.map((m) => (
              <Chip key={m.id} label={m.name} active={sessionOptions.model === m.id} onPress={() => onSetModel(m.id)} />
            )) : (
              <Text style={styles.empty}>暂无模型列表（可在桌面端打开会话后获取）</Text>
            )}
          </View>

          <Text style={styles.sheetLabel}>权限模式</Text>
          <View style={styles.chipRow}>
            {MODE_PRESETS.map((m) => (
              <Chip key={m.id} label={m.label} active={sessionOptions.mode === m.id} onPress={() => onSetMode(m.id)} />
            ))}
          </View>

          <Text style={styles.sheetLabel}>思考强度</Text>
          <View style={styles.chipRow}>
            {THOUGHT_LEVELS.map((lvl) => (
              <Chip key={lvl} label={lvl} active={sessionOptions.reasoning === lvl} onPress={() => onSetReasoning(lvl)} />
            ))}
          </View>

          <TouchableOpacity style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>完成</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: '#8b949e', fontSize: 13, marginTop: 12 },
  errorText: { color: '#f85149', fontSize: 14, marginBottom: 16, textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 },
  back: { color: '#2f81f7', fontSize: 15 },
  headerTitle: { color: '#e6edf3', fontSize: 16, fontWeight: '600', flex: 1 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderColor: '#21262d' },
  rowTitle: { color: '#e6edf3', fontSize: 15 },
  rowSub: { color: '#6e7681', fontSize: 12, marginTop: 2 },
  empty: { color: '#6e7681', fontSize: 13, textAlign: 'center', marginTop: 24 },
  bubble: { padding: 10, borderRadius: 10, marginVertical: 4, maxWidth: '85%' },
  bubbleUser: { backgroundColor: '#1f6feb', alignSelf: 'flex-end' },
  bubbleAgent: { backgroundColor: '#161b22', alignSelf: 'flex-start' },
  bubbleText: { color: '#e6edf3', fontSize: 14 },
  composer: { paddingTop: 8 },
  composerMeta: { paddingVertical: 6, paddingHorizontal: 4, marginBottom: 4 },
  metaLabel: { color: '#8b949e', fontSize: 12 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e6edf3',
    fontSize: 14,
    maxHeight: 120,
  },
  sendBtn: { backgroundColor: '#2f81f7', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  stopBtn: { backgroundColor: '#da3633', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btn: { backgroundColor: '#2f81f7', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginTop: 16 },
  btnGhost: { marginTop: 8, padding: 8 },
  btnText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  permBar: { paddingVertical: 8 },
  permCard: { backgroundColor: '#161b22', borderLeftWidth: 3, borderLeftColor: '#d29922', borderRadius: 8, padding: 10 },
  permTitle: { color: '#e6edf3', fontSize: 13, fontWeight: '600' },
  permDesc: { color: '#8b949e', fontSize: 12, marginTop: 4 },
  permActions: { flexDirection: 'row', gap: 8, marginTop: 8, justifyContent: 'flex-end' },
  permAllow: { backgroundColor: '#238636', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  permDeny: { backgroundColor: '#da3633', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#0d1117', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '80%' },
  modalTitle: { color: '#e6edf3', fontSize: 16, fontWeight: '600', marginBottom: 12 },
  sheetLabel: { color: '#8b949e', fontSize: 12, marginTop: 12, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#161b22', borderWidth: 1, borderColor: '#30363d' },
  chipActive: { backgroundColor: '#1f6feb', borderColor: '#1f6feb' },
  chipText: { color: '#e6edf3', fontSize: 12 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  taskRow: { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#21262d' },
  taskTitle: { color: '#e6edf3', fontSize: 14 },
  taskSub: { color: '#6e7681', fontSize: 12, marginTop: 2 },
});