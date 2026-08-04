const { contextBridge, ipcRenderer, webUtils } = require('electron');

const activeCodeBuddyStreams = new Set();

window.addEventListener('beforeunload', () => {
  for (const streamId of activeCodeBuddyStreams) {
    ipcRenderer.send('codebuddy:closeStream', streamId);
  }
  activeCodeBuddyStreams.clear();
});

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowShow: () => ipcRenderer.send('window:show'),
  acknowledgeQuit: (requestId) => ipcRenderer.send('app:acknowledgeQuit', requestId),
  holdQuit: (requestId) => ipcRenderer.send('app:holdQuit', requestId),
  resumeQuit: (requestId, resumeMs) => ipcRenderer.send('app:resumeQuit', { requestId, resumeMs }),
  confirmQuit: (requestId) => ipcRenderer.send('app:confirmQuit', requestId),
  cancelQuit: (requestId, reason) => ipcRenderer.send('app:cancelQuit', { requestId, reason }),
  onQuitRequested: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('app:quitRequested', listener);
    return () => ipcRenderer.removeListener('app:quitRequested', listener);
  },
  windowReload: () => ipcRenderer.send('window:reload'),
  openDevTools: () => ipcRenderer.send('window:openDevTools'),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  reportRendererError: (payload) => ipcRenderer.invoke('app:reportRendererError', payload),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  openReleasePage: (releaseUrl) => ipcRenderer.invoke('app:openReleasePage', releaseUrl),
  openUpdateDownload: (downloadUrl) => ipcRenderer.invoke('app:openUpdateDownload', downloadUrl),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  rightBrowserOpen: (url) => ipcRenderer.invoke('rightBrowser:open', url),
  rightBrowserSetBounds: (bounds) => ipcRenderer.send('rightBrowser:setBounds', bounds),
  rightBrowserClose: () => ipcRenderer.invoke('rightBrowser:close'),
  onRightBrowserState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('rightBrowser:state', listener);
    return () => ipcRenderer.removeListener('rightBrowser:state', listener);
  },
  listMcpConfigs: (cwd) => ipcRenderer.invoke('mcp:listConfigs', cwd),
  listSandboxes: () => ipcRenderer.invoke('sandbox:list'),
  killSandbox: (sandboxId) => ipcRenderer.invoke('sandbox:kill', sandboxId),
  cleanSandboxes: () => ipcRenderer.invoke('sandbox:clean'),
  listBackgroundSessions: () => ipcRenderer.invoke('backgroundSession:list'),
  startBackgroundSession: (payload) => ipcRenderer.invoke('backgroundSession:start', payload),
  readBackgroundSessionLogs: (pid) => ipcRenderer.invoke('backgroundSession:logs', pid),
  killBackgroundSession: (pid) => ipcRenderer.invoke('backgroundSession:kill', pid),
  openBackgroundSessionEndpoint: (endpoint) => ipcRenderer.invoke('backgroundSession:openEndpoint', endpoint),
  attachBackgroundSession: (pid) => ipcRenderer.invoke('backgroundSession:attach', pid),
  getDaemonServiceStatus: () => ipcRenderer.invoke('daemonService:status'),
  installDaemonService: (payload) => ipcRenderer.invoke('daemonService:install', payload),
  uninstallDaemonService: () => ipcRenderer.invoke('daemonService:uninstall'),
  getCliMaintenanceInfo: () => ipcRenderer.invoke('cliMaintenance:getInfo'),
  getCliDiskAuth: () => ipcRenderer.invoke('cliAuth:getDiskAuth'),
  runCliDoctor: () => ipcRenderer.invoke('cliMaintenance:doctor'),
  updateCodeBuddyCli: () => ipcRenderer.invoke('cliMaintenance:update'),
  installCodeBuddyCli: (target) => ipcRenderer.invoke('cliMaintenance:install', target),
  ensureRecommendedCodeBuddyCli: () => ipcRenderer.invoke('cliMaintenance:ensureRecommended'),
  updateInstalledPlugin: (payload) => ipcRenderer.invoke('pluginMaintenance:update', payload),
  previewPluginDependencyPrune: (payload) => ipcRenderer.invoke('pluginMaintenance:previewPrune', payload),
  prunePluginDependencies: (payload) => ipcRenderer.invoke('pluginMaintenance:prune', payload),
  listModelConfigs: () => ipcRenderer.invoke('modelConfig:list'),
  saveModelConfig: (payload) => ipcRenderer.invoke('modelConfig:save', payload),
  deleteModelConfig: (modelId) => ipcRenderer.invoke('modelConfig:delete', modelId),
  openModelConfig: () => ipcRenderer.invoke('modelConfig:open'),
  exportDiagnostics: () => ipcRenderer.invoke('app:exportDiagnostics'),
  showTaskNotification: (payload) => ipcRenderer.invoke('notification:showTaskResult', payload),
  consumeTaskNotificationTarget: () => ipcRenderer.invoke('notification:consumeOpenThread'),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  runGit: (request) => ipcRenderer.invoke('git:run', request),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  chooseAttachments: (options) => ipcRenderer.invoke('attachment:choose', options),
  readDroppedAttachments: (files = []) => {
    const filePaths = Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('attachment:readDropped', filePaths);
  },
  readAttachments: (filePaths) => ipcRenderer.invoke('attachment:read', filePaths),
  saveClipboardImage: (payload) => ipcRenderer.invoke('attachment:saveClipboardImage', payload),
  loadProductState: () => ipcRenderer.invoke('productState:load'),
  saveProductState: (state) => ipcRenderer.invoke('productState:save', state),
  saveProductStateSync: (state) => ipcRenderer.sendSync('productState:saveSync', state),
  ensureProjectRuntime: (request) => ipcRenderer.invoke('runtime:ensure', request),
  listProjectRuntimes: () => ipcRenderer.invoke('runtime:list'),
  stopProjectRuntime: (projectId) => ipcRenderer.invoke('runtime:stop', projectId),
  restartProjectRuntime: (request) => ipcRenderer.invoke('runtime:restart', request),
  onProjectRuntimeStatus: (handler) => {
    const listener = (_event, runtime) => handler(runtime);
    ipcRenderer.on('runtime:status', listener);
    return () => ipcRenderer.removeListener('runtime:status', listener);
  },
  // 手机远程（与 channel「远程控制」分离）
  mobileRemoteGetStatus: () => ipcRenderer.invoke('mobileRemote:getStatus'),
  mobileRemoteGetConfig: () => ipcRenderer.invoke('mobileRemote:getConfig'),
  mobileRemoteSetConfig: (config) => ipcRenderer.invoke('mobileRemote:setConfig', config),
  mobileRemoteGetPairingOffer: () => ipcRenderer.invoke('mobileRemote:getPairingOffer'),
  mobileRemoteGetPairingOfferWithToken: () => ipcRenderer.invoke('mobileRemote:getPairingOfferWithToken'),
  mobileRemoteStart: () => ipcRenderer.invoke('mobileRemote:start'),
  mobileRemoteStop: () => ipcRenderer.invoke('mobileRemote:stop'),
  mobileRemoteListDevices: () => ipcRenderer.invoke('mobileRemote:listDevices'),
  mobileRemoteRevokeDevice: (deviceId) => ipcRenderer.invoke('mobileRemote:revokeDevice', deviceId),
  requestCodeBuddy: (request) => ipcRenderer.invoke('codebuddy:request', request),
  openCodeBuddyStream: (request, handlers = {}) => {
    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeCodeBuddyStreams.add(streamId);
    let closed = false;
    let openErrorReported = false;
    const cleanup = (notifyMain = false) => {
      if (closed) return;
      closed = true;
      activeCodeBuddyStreams.delete(streamId);
      ipcRenderer.removeListener('codebuddy:streamMessage', onMessage);
      ipcRenderer.removeListener('codebuddy:streamError', onError);
      ipcRenderer.removeListener('codebuddy:streamEnd', onEnd);
      if (notifyMain) ipcRenderer.send('codebuddy:closeStream', streamId);
    };
    const onMessage = (_event, payload) => {
      if (payload?.streamId !== streamId) return;
      handlers.onMessage?.(payload.message);
    };
    const onError = (_event, payload) => {
      if (payload?.streamId !== streamId) return;
      openErrorReported = true;
      // Normalize stream errors so callers can classify by HTTP status / kind.
      // Legacy string payloads (no status/kind) are treated as transport-unknown.
      handlers.onError?.({
        message:
          typeof payload?.error === 'string'
            ? payload.error
            : payload?.error?.message || payload?.error || String(payload?.error),
        status: typeof payload?.status === 'number' ? payload.status : null,
        kind: payload?.kind || (payload?.status ? 'http' : null),
      });
      if (String(request.method || 'GET').toUpperCase() !== 'GET') cleanup();
    };
    const onEnd = (_event, payload) => {
      if (payload?.streamId !== streamId) return;
      handlers.onEnd?.(payload);
      cleanup();
    };
    ipcRenderer.on('codebuddy:streamMessage', onMessage);
    ipcRenderer.on('codebuddy:streamError', onError);
    ipcRenderer.on('codebuddy:streamEnd', onEnd);
    ipcRenderer
      .invoke('codebuddy:openStream', { ...request, streamId })
      .then((result) => {
        if (result?.ok !== false) return;
        if (!closed && !openErrorReported) {
          handlers.onError?.({
            message: result.error || `ACP stream failed: ${result.status || 0}`,
            status: typeof result?.status === 'number' ? result.status : null,
            kind: typeof result?.status === 'number' ? 'http' : null,
          });
        }
        cleanup();
      })
      .catch((error) => {
        if (!closed)
          handlers.onError?.({
            message: error?.message || String(error),
            status: null,
            kind: null,
          });
        cleanup();
      });
    return {
      close: () => cleanup(true),
    };
  },
});
