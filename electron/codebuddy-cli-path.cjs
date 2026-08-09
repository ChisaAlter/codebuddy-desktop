const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function pathEntries(env = process.env) {
  return String(env.Path || env.PATH || '')
    .split(path.delimiter)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function uniquePaths(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function windowsNpmGlobalDirs(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const appData = env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : null);
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    appData ? path.join(appData, 'npm') : null,
    path.join(programFiles, 'nodejs'),
    path.join(programFilesX86, 'nodejs'),
  ].filter(Boolean);
}

// 注册表 Path 的 TTL 缓存：CLI 安装/卸载是低频事件，60s 内复用结果即可。
// 否则每次 CLI spawn 解析（listBackgroundSessions 轮询、运行时 ensure、
// cliMaintenance 等高频路径）都同步执行 2 次 reg query（各最多 3s），
// 阻塞主进程事件循环并产生瞬时子进程。仅在未注入 deps.execReg（真实路径）
// 时生效，测试注入不受影响。
let registryPathCache = null;
let registryPathCacheAt = 0;
const REGISTRY_PATH_TTL_MS = 60 * 1000;

/**
 * 读取 Windows 注册表中的用户/系统 Path。
 * GUI 从快捷方式启动时 process.env.PATH 常是登录时快照；用户随后安装 CLI 后，
 * 只有重新读注册表才能在不重启应用的情况下看到新 PATH。
 *
 * deps.execReg 便于单测注入；默认用 reg query。
 */
function readWindowsRegistryPathEntries(deps = {}) {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (!deps.execReg && registryPathCache !== null && now - registryPathCacheAt < REGISTRY_PATH_TTL_MS) {
    return registryPathCache;
  }
  const execReg =
    deps.execReg ||
    ((args) =>
      execFileSync('reg', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 256 * 1024,
      }));

  const keys = [
    ['query', 'HKCU\\Environment', '/v', 'Path'],
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'],
  ];
  const entries = [];
  for (const args of keys) {
    try {
      const output = String(execReg(args) || '');
      // REG_EXPAND_SZ / REG_SZ  路径值
      const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      if (!match) continue;
      const raw = match[1].trim();
      if (!raw) continue;
      for (const part of raw.split(';')) {
        const item = String(part || '').trim();
        if (item) entries.push(item);
      }
    } catch (_) {
      // 注册表不可读时静默回退，不影响现有 PATH 逻辑
    }
  }
  if (!deps.execReg) {
    registryPathCache = entries;
    registryPathCacheAt = now;
  }
  return entries;
}

/**
 * GUI 从快捷方式启动时，偶发拿不到最新用户 PATH。
 * 在 Windows 上：
 * 1) 合并注册表用户/系统 Path（覆盖进程启动后新装的 CLI）
 * 2) 把常见 npm 全局目录补进 PATH，便于找到 codebuddy.cmd
 */
function withAugmentedPath(env = process.env, deps = {}) {
  if (process.platform !== 'win32') return { ...env };
  const current = pathEntries(env);
  const registryEntries = readWindowsRegistryPathEntries(deps);
  const extras = windowsNpmGlobalDirs(env).filter((dir) => dirExists(dir));
  // 优先级：npm 全局目录 > 注册表最新 Path > 进程启动时 Path
  const next = uniquePaths([...extras, ...registryEntries, ...current]);
  if (next.length === current.length && next.every((item, index) => item === current[index])) {
    return { ...env };
  }
  const joined = next.join(path.delimiter);
  return {
    ...env,
    Path: joined,
    PATH: joined,
  };
}

function candidateNames(basename) {
  if (process.platform !== 'win32') return [basename];
  return [`${basename}.cmd`, `${basename}.exe`, basename, `${basename}.bat`];
}

function findOnPath(basename, env = process.env) {
  for (const dir of pathEntries(env)) {
    for (const name of candidateNames(basename)) {
      const fullPath = path.join(dir, name);
      if (fileExists(fullPath)) return fullPath;
    }
  }
  return null;
}

function resolveNodeExecutable(env = process.env) {
  const fromPath = findOnPath('node', env);
  if (fromPath) return fromPath;
  if (process.platform === 'win32') {
    for (const dir of windowsNpmGlobalDirs(env)) {
      const candidate = path.join(dir, 'node.exe');
      if (fileExists(candidate)) return candidate;
    }
  }
  // 打包 Electron 的 process.execPath 是 GUI 本体，不能直接当 node 用。
  return 'node';
}

function resolveCodeBuddyJsEntry(cliPath) {
  if (!cliPath) return null;
  const dir = path.dirname(cliPath);
  const candidates = [
    path.join(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    path.join(dir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy.js'),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function quoteForCmd(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * 解析可安全 shell:false 启动的 codebuddy 调用方式。
 * Windows 上 npm 全局命令是 .cmd 包装；CreateProcess 无法直接执行 .cmd，
 * 因此优先解析到 node + 真实 JS 入口，避免再走 cmd 二次分词。
 */
function resolveCodeBuddySpawnSpec(args = [], env = process.env, deps = {}) {
  const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const effectiveEnv = withAugmentedPath(env, deps);
  const found = findOnPath('codebuddy', effectiveEnv);

  if (!found) {
    return {
      command: 'codebuddy',
      args: argv,
      env: effectiveEnv,
      resolved: false,
      source: null,
    };
  }

  const isWindowsShim = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(found) || !path.extname(found));
  if (isWindowsShim) {
    const entry = resolveCodeBuddyJsEntry(found);
    if (entry) {
      return {
        command: resolveNodeExecutable(effectiveEnv),
        args: [entry, ...argv],
        env: effectiveEnv,
        resolved: true,
        source: found,
        entry,
      };
    }

    // 兜底：通过 cmd 执行 .cmd，参数单独引用，避免空格路径被拆坏。
    const comspec = effectiveEnv.ComSpec || process.env.ComSpec || 'cmd.exe';
    const commandLine = [quoteForCmd(found), ...argv.map(quoteForCmd)].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', commandLine],
      env: effectiveEnv,
      resolved: true,
      source: found,
      entry: null,
    };
  }

  return {
    command: found,
    args: argv,
    env: effectiveEnv,
    resolved: true,
    source: found,
    entry: null,
  };
}

/**
 * 解析 npm 调用方式（用于零安装时 npm install -g @tencent-ai/codebuddy-code）。
 * Windows 上 npm 通常是 .cmd，与 codebuddy 一样走 cmd /d /s /c。
 */
function resolveNpmSpawnSpec(args = [], env = process.env, deps = {}) {
  const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];
  const effectiveEnv = withAugmentedPath(env, deps);
  const found = findOnPath('npm', effectiveEnv);

  if (!found) {
    return {
      command: 'npm',
      args: argv,
      env: effectiveEnv,
      resolved: false,
      source: null,
    };
  }

  const isWindowsShim = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(found) || !path.extname(found));
  if (isWindowsShim) {
    const comspec = effectiveEnv.ComSpec || process.env.ComSpec || 'cmd.exe';
    const commandLine = [quoteForCmd(found), ...argv.map(quoteForCmd)].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', commandLine],
      env: effectiveEnv,
      resolved: true,
      source: found,
    };
  }

  return {
    command: found,
    args: argv,
    env: effectiveEnv,
    resolved: true,
    source: found,
  };
}

module.exports = {
  pathEntries,
  withAugmentedPath,
  findOnPath,
  resolveCodeBuddyJsEntry,
  resolveCodeBuddySpawnSpec,
  resolveNpmSpawnSpec,
  quoteForCmd,
  readWindowsRegistryPathEntries,
};
