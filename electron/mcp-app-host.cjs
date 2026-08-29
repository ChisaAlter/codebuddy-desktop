// G6: MCP Apps（ui:// 交互界面）宿主 —— 每个 App 一个隔离 WebContentsView。
// 安全模型对齐 WebUI sandbox_proxy：guest HTML 不与主渲染进程同源/同进程，
// sandbox + contextIsolation + 无 preload + 内存 session（不落盘、无权限），
// 禁止任何导航，window.open 仅放行 http/https 且交给系统浏览器。
// IPC 侧由 main.cjs 用 requireTrustedMainSender 把关。

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_VIEWS = 4;

function validBounds(rawBounds = {}) {
  const x = Number(rawBounds.x);
  const y = Number(rawBounds.y);
  const width = Number(rawBounds.width);
  const height = Number(rawBounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (x < 0 || y < 0 || width < 0 || height < 0 || width > 10000 || height > 10000) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function validAppId(rawId) {
  return typeof rawId === 'string' && /^[a-z0-9-]{1,64}$/i.test(rawId) ? rawId : null;
}

/**
 * @param {object} deps
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {typeof import('electron').WebContentsView} deps.WebContentsView
 * @param {typeof import('electron').session} deps.session
 * @param {(url: string) => string | null} deps.normalizeExternalHttpUrl
 * @param {import('electron').Shell} deps.shell
 */
function createMcpAppHost({ getMainWindow, WebContentsView, session, normalizeExternalHttpUrl, shell }) {
  /** @type {Map<string, import('electron').WebContentsView>} */
  const views = new Map();

  function close(appId) {
    const view = views.get(appId);
    if (!view) return false;
    views.delete(appId);
    const mainWindow = getMainWindow();
    try {
      mainWindow?.contentView?.removeChildView?.(view);
    } catch (_) {}
    try {
      view.webContents?.close?.();
    } catch (_) {}
    return true;
  }

  function closeAll() {
    for (const appId of [...views.keys()]) close(appId);
  }

  function open({ id, html, bounds }) {
    const appId = validAppId(id);
    if (!appId) throw new Error('MCP App id 无效');
    if (!WebContentsView) throw new Error('当前 Electron 不支持 WebContentsView');
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不可用');
    const source = typeof html === 'string' ? html : '';
    if (!source.trim()) throw new Error('MCP App HTML 为空');
    if (Buffer.byteLength(source, 'utf8') > MAX_HTML_BYTES) throw new Error('MCP App HTML 过大');
    close(appId);
    if (views.size >= MAX_VIEWS) {
      const oldest = views.keys().next().value;
      if (oldest) close(oldest);
    }

    // 内存 session（无 persist: 前缀）：不共享 cookie/storage，不授予任何权限。
    const guestSession = session.fromPartition(`mcp-app:${appId}:${Date.now()}`);
    guestSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    const view = new WebContentsView({
      webPreferences: {
        session: guestSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        disableDialogs: true,
      },
    });
    // guest 是静态 ui:// 文档：一律禁止页内导航；新窗口仅放行 http/https 到系统浏览器。
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = normalizeExternalHttpUrl(url);
      if (target) shell.openExternal(target).catch(() => {});
      return { action: 'deny' };
    });
    const guard = (event) => {
      try {
        event.preventDefault();
      } catch (_) {}
    };
    view.webContents.on('will-navigate', guard);
    view.webContents.on('will-redirect', guard);

    mainWindow.contentView.addChildView(view);
    const initialBounds = validBounds(bounds);
    if (initialBounds) view.setBounds(initialBounds);
    views.set(appId, view);
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    view.webContents.loadURL(dataUrl).catch(() => {});
    return { id: appId };
  }

  function setBounds(appId, rawBounds) {
    const view = views.get(validAppId(appId) || '');
    const bounds = validBounds(rawBounds);
    if (!view || !bounds) return false;
    view.setBounds(bounds);
    return true;
  }

  return { open, setBounds, close, closeAll, validBounds, validAppId, size: () => views.size };
}

module.exports = { createMcpAppHost, validBounds, validAppId, MAX_HTML_BYTES, MAX_VIEWS };
