const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const { resolveCodeBuddySpawnSpec } = require('./codebuddy-cli-path.cjs');
const { resolveAccountLoginSiteForRuntime } = require('./codebuddy-auth-site.cjs');

const CLI_UNAVAILABLE_MESSAGE = '未找到 CodeBuddy CLI。请先安装 CodeBuddy，并确认在命令行中可以直接运行 codebuddy。';

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @param {{ accountLoginSite?: 'cn' | 'global' | null }} [options]
 * accountLoginSite:
 *   - cn → CODEBUDDY_INTERNET_ENVIRONMENT=internal (China edition)
 *   - global → unset (international default; never force ioa)
 *   - omitted/null → detect from on-disk OAuth domain, else preserve process env
 *
 * Critical: disk auth domain must match product env. Forcing global while
 * token domain is www.codebuddy.cn causes login-after-login loops.
 */
function buildCodeBuddyRuntimeEnvironment(source = process.env, options = {}) {
  // 不要默认强行注入 ioa：会覆盖 CLI 默认云端产品配置，导致已登录 token 以
  // auth-type:cli-external-link、token-type:undefined 形式被拒（401），GUI 反复要求登录。
  const base = { ...source };
  const site = resolveAccountLoginSiteForRuntime(options?.accountLoginSite, source);
  if (site === 'cn') {
    base.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
  } else if (site === 'global') {
    delete base.CODEBUDDY_INTERNET_ENVIRONMENT;
  } else {
    // null site: preserve non-empty process env only (advanced / legacy).
    const internetEnv = String(source.CODEBUDDY_INTERNET_ENVIRONMENT || '').trim();
    if (internetEnv) base.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    else delete base.CODEBUDDY_INTERNET_ENVIRONMENT;
  }
  // Reuse CLI path resolution so packaged GUI inherits npm global PATH extras.
  return resolveCodeBuddySpawnSpec(['--serve'], base).env || base;
}

function isCliUnavailable(value) {
  return /(?:codebuddy.*(?:not recognized|not found)|不是内部或外部命令|找不到.*codebuddy|ENOENT)/i.test(
    String(value || ''),
  );
}

function decodeProcessOutput(data) {
  const utf8 = data.toString('utf8');
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(data);
  } catch (_) {
    return utf8;
  }
}

function codeBuddyFetchOptions(options = {}) {
  return { ...options, credentials: 'include' };
}

function publicRuntime(entry) {
  if (!entry) return null;
  return {
    projectId: entry.projectId,
    cwd: entry.cwd,
    status: entry.status,
    port: entry.port || null,
    pid: entry.proc?.pid || null,
    error: entry.error || null,
    startedAt: entry.startedAt || null,
  };
}

function runtimeConnection(entry) {
  return { ...publicRuntime(entry), password: entry.password || null };
}

function createCodeBuddyRuntimeManager({ net, logger = () => {}, onStatus = () => {} }) {
  const runtimes = new Map();
  // Per-project in-flight ensure promises. Without this, two concurrent
  // ensure(projectId) calls (e.g. restart racing an ensureProjectRuntime IPC)
  // could both pass the "no running entry / no startPromise" checks and each
  // spawn a CodeBuddy process for the same project — leaking one process + its
  // port. Coalescing on a single promise guarantees only one start at a time.
  const inflight = new Map();

  function emit(entry) {
    const value = publicRuntime(entry);
    onStatus(value);
    return value;
  }

  async function authenticate(entry) {
    const url = `http://127.0.0.1:${entry.port}/?password=${encodeURIComponent(entry.password)}`;
    const response = await net.fetch(url, codeBuddyFetchOptions({ headers: { 'X-CodeBuddy-Request': '1' } }));
    if (!response.ok) throw new Error(`CodeBuddy authentication failed: ${response.status}`);
  }

  function stopProcess(entry) {
    if (!entry?.proc || entry.proc.killed) return;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(entry.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        entry.proc.kill('SIGTERM');
      }
    } catch (_) {
      try {
        entry.proc.kill('SIGKILL');
      } catch (_) {}
    }
  }

  function start(entry) {
    const runId = (entry.runId || 0) + 1;
    entry.runId = runId;
    entry.status = 'starting';
    entry.error = null;
    emit(entry);
    logger(`Starting CodeBuddy runtime project=${entry.projectId} cwd=${entry.cwd}`);

    const promise = new Promise((resolve, reject) => {
      const runtimeEnv = buildCodeBuddyRuntimeEnvironment(process.env, {
        accountLoginSite: entry.accountLoginSite || null,
      });
      const spec = resolveCodeBuddySpawnSpec(['--serve'], runtimeEnv);
      const proc = spawn(spec.command, spec.args, {
        cwd: entry.cwd,
        env: spec.env || runtimeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      entry.proc = proc;
      entry.startedAt = new Date().toISOString();
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;

      entry.cancelStart = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error('CodeBuddy start cancelled'));
      };

      const finish = async (error) => {
        if (settled || entry.runId !== runId) return;
        if (error) {
          settled = true;
          clearTimeout(timeoutId);
          entry.status = 'error';
          entry.error = error.message;
          emit(entry);
          reject(error);
          return;
        }
        if (!entry.port || !entry.password) return;
        settled = true;
        clearTimeout(timeoutId);
        try {
          await authenticate(entry);
          // authenticate 期间 stop() 可能插入：它会 bump runId、杀进程并把 entry
          // 从 map 移除。不复查就会向渲染进程广播假的 running 状态，并把一个
          // 端口已被清空的连接 resolve 给等待中的 ensure 调用方。
          if (entry.runId !== runId) {
            reject(new Error('CodeBuddy start cancelled'));
            return;
          }
          logger(`CodeBuddy runtime authenticated project=${entry.projectId} port=${entry.port}`);
          entry.status = 'running';
          entry.error = null;
          logger(`CodeBuddy runtime ready project=${entry.projectId} port=${entry.port}`);
          emit(entry);
          resolve(runtimeConnection(entry));
        } catch (authError) {
          entry.status = 'error';
          entry.error = authError.message;
          stopProcess(entry);
          emit(entry);
          reject(authError);
        }
      };

      const timeoutId = setTimeout(() => {
        finish(new Error('CodeBuddy start timeout: port or password not announced'));
        stopProcess(entry);
      }, 30000);

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdoutBuffer = `${stdoutBuffer}${text}`.slice(-12000);
        if (!entry.port) {
          const match = stdoutBuffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) entry.port = Number(match[1]);
        }
        if (!entry.password) {
          const passwordMatch = stdoutBuffer.match(/Password\s+([\w-]+)/) || stdoutBuffer.match(/\?password=([\w-]+)/);
          if (passwordMatch) entry.password = passwordMatch[1];
        }
        finish();
      });

      proc.stderr.on('data', (data) => {
        const text = decodeProcessOutput(data).trim();
        stderrBuffer = `${stderrBuffer}${text}\n`.slice(-8000);
        if (text) logger(`CodeBuddy runtime stderr project=${entry.projectId}: ${text}`);
      });

      proc.on('error', (error) => {
        finish(isCliUnavailable(error?.code || error?.message) ? new Error(CLI_UNAVAILABLE_MESSAGE) : error);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timeoutId);
        if (entry.runId !== runId) return;
        entry.proc = null;
        entry.port = null;
        entry.password = null;
        if (!settled) {
          finish(
            new Error(
              isCliUnavailable(stderrBuffer)
                ? CLI_UNAVAILABLE_MESSAGE
                : `CodeBuddy exited before ready (code=${code}, signal=${signal})`,
            ),
          );
          return;
        }
        if (entry.status !== 'stopping' && entry.status !== 'error') {
          entry.status = code === 0 ? 'stopped' : 'error';
          entry.error = code === 0 ? null : `CodeBuddy exited (code=${code}, signal=${signal})`;
          emit(entry);
        }
      });
    });
    const trackedPromise = promise.finally(() => {
      if (entry.startPromise === trackedPromise) entry.startPromise = null;
      if (entry.runId === runId) entry.cancelStart = null;
    });
    entry.startPromise = trackedPromise;

    return trackedPromise;
  }

  async function ensure(projectId, cwd, options = {}) {
    // Coalesce concurrent ensure calls for the same project onto one in-flight
    // promise. The first caller runs the real start logic; later callers await
    // the same promise and observe the same runtime connection. This closes the
    // restart-vs-ensure race where two ensures could each spawn a process.
    const pending = inflight.get(projectId);
    if (pending) return pending;
    const work = (async () => {
      try {
        return await ensureInner(projectId, cwd, options);
      } finally {
        inflight.delete(projectId);
      }
    })();
    inflight.set(projectId, work);
    return work;
  }

  async function ensureInner(projectId, cwd, options = {}) {
    if (!projectId) throw new Error('projectId is required');
    if (!cwd) throw new Error('project cwd is required');
    // Always resolve against on-disk OAuth so spawn env matches token domain.
    // null means "no forced site" (preserve process env only).
    const accountLoginSite = resolveAccountLoginSiteForRuntime(options?.accountLoginSite, process.env);
    let entry = runtimes.get(projectId);
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch (_) {
      throw new Error(`项目目录不存在或不可访问: ${cwd}`);
    }
    if (
      entry?.status === 'running' &&
      entry.proc &&
      !entry.proc.killed &&
      (entry.accountLoginSite || null) === accountLoginSite
    ) {
      return runtimeConnection(entry);
    }
    if (entry?.startPromise && (entry.accountLoginSite || null) === accountLoginSite) {
      return entry.startPromise;
    }
    if (entry && (entry.cwd !== cwd || (entry.accountLoginSite || null) !== accountLoginSite)) {
      await stop(projectId);
      entry = null;
    }
    if (!entry) {
      entry = {
        projectId,
        cwd,
        accountLoginSite,
        status: 'idle',
        port: null,
        password: null,
        proc: null,
        startPromise: null,
        cancelStart: null,
        runId: 0,
        error: null,
        startedAt: null,
      };
      runtimes.set(projectId, entry);
    } else {
      entry.accountLoginSite = accountLoginSite;
    }
    return start(entry);
  }

  async function stop(projectId) {
    const entry = runtimes.get(projectId);
    if (!entry) return null;
    entry.status = 'stopping';
    emit(entry);
    entry.cancelStart?.();
    entry.runId = (entry.runId || 0) + 1;
    stopProcess(entry);
    entry.proc = null;
    entry.port = null;
    entry.password = null;
    entry.startPromise = null;
    entry.cancelStart = null;
    entry.status = 'stopped';
    entry.error = null;
    // Remove the entry from the map as soon as stop completes. Previously this
    // only happened in `restart`, leaving a window between `await stop` and the
    // subsequent `runtimes.delete` where a concurrent `ensure` could reuse the
    // stopped entry, start a new process against it, and then have restart's
    // delete evict that live entry — producing an orphan process invisible to
    // list()/stopAll(). Deleting here makes stop + ensure/restart atomic from
    // the map's perspective: any subsequent ensure sees no entry and creates a
    // fresh one, deduped by the inflight map below.
    runtimes.delete(projectId);
    return emit(entry);
  }

  async function restart(projectId, cwd, options = {}) {
    await stop(projectId);
    // stop() already removed the entry from the map; no separate delete needed.
    return ensure(projectId, cwd, options);
  }

  function list() {
    return Array.from(runtimes.values(), publicRuntime);
  }

  async function stopAll() {
    await Promise.allSettled(Array.from(runtimes.keys(), (projectId) => stop(projectId)));
    runtimes.clear();
  }

  return { ensure, list, restart, stop, stopAll };
}

module.exports = {
  buildCodeBuddyRuntimeEnvironment,
  codeBuddyFetchOptions,
  createCodeBuddyRuntimeManager,
  decodeProcessOutput,
};
