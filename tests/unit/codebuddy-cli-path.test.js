import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findOnPath,
  quoteForCmd,
  readWindowsRegistryPathEntries,
  resolveCodeBuddyJsEntry,
  resolveCodeBuddySpawnSpec,
  resolveNpmSpawnSpec,
  withAugmentedPath,
} = require('../../electron/codebuddy-cli-path.cjs');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('codebuddy-cli-path', () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length) {
      const dir = cleanup.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quotes cmd arguments with spaces', () => {
    expect(quoteForCmd('C:\\Program Files\\app\\codebuddy.cmd')).toBe('"C:\\Program Files\\app\\codebuddy.cmd"');
    expect(quoteForCmd('plain')).toBe('plain');
  });

  it('finds codebuddy.cmd on PATH and resolves the npm JS entry', () => {
    const root = makeTempDir('codebuddy-cli-path-');
    cleanup.push(root);
    const binDir = path.join(root, 'npm');
    const entryDir = path.join(binDir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin');
    fs.mkdirSync(entryDir, { recursive: true });
    const cmdPath = path.join(binDir, 'codebuddy.cmd');
    const entryPath = path.join(entryDir, 'codebuddy');
    const nodePath = path.join(binDir, 'node.exe');
    fs.writeFileSync(cmdPath, '@ECHO off\r\n');
    fs.writeFileSync(entryPath, '#!/usr/bin/env node\nconsole.log("ok")\n');
    fs.writeFileSync(nodePath, 'fake');

    const env = {
      Path: binDir,
      PATH: binDir,
      USERPROFILE: root,
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      ProgramFiles: path.join(root, 'Program Files'),
      'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
    };

    expect(findOnPath('codebuddy', env)).toBe(cmdPath);
    expect(resolveCodeBuddyJsEntry(cmdPath)).toBe(entryPath);

    // 注入空注册表，避免本机 HKCU Path 抢先提供真实 node.exe
    const deps = { execReg: () => '' };
    const spec = resolveCodeBuddySpawnSpec(['--version'], env, deps);
    expect(spec.resolved).toBe(true);
    expect(spec.command).toBe(nodePath);
    expect(spec.args).toEqual([entryPath, '--version']);
    expect(spec.source).toBe(cmdPath);
  });

  it('augments PATH with npm global dirs when missing', () => {
    if (process.platform !== 'win32') return;
    const root = makeTempDir('codebuddy-cli-augment-');
    cleanup.push(root);
    const npmDir = path.join(root, 'AppData', 'Roaming', 'npm');
    fs.mkdirSync(npmDir, { recursive: true });
    const env = {
      Path: 'C:\\Windows\\System32',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: root,
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      ProgramFiles: path.join(root, 'Program Files'),
      'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
    };
    const next = withAugmentedPath(env, { execReg: () => '' });
    expect(String(next.Path).toLowerCase()).toContain(npmDir.toLowerCase());
  });

  it('parses Windows registry Path entries from reg query output', () => {
    if (process.platform !== 'win32') return;
    const output = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    C:\\Users\\demo\\AppData\\Roaming\\npm;C:\\Tools\\bin',
      '',
    ].join('\r\n');
    const entries = readWindowsRegistryPathEntries({
      execReg: (args) => {
        if (args.includes('HKCU\\Environment')) return output;
        throw new Error('skip');
      },
    });
    expect(entries).toEqual(['C:\\Users\\demo\\AppData\\Roaming\\npm', 'C:\\Tools\\bin']);
  });

  it('resolves npm.cmd on Windows via cmd shim', () => {
    if (process.platform !== 'win32') return;
    const root = makeTempDir('codebuddy-npm-path-');
    cleanup.push(root);
    const binDir = path.join(root, 'npm');
    fs.mkdirSync(binDir, { recursive: true });
    const npmCmd = path.join(binDir, 'npm.cmd');
    fs.writeFileSync(npmCmd, '@ECHO off\r\n');
    const env = {
      Path: binDir,
      PATH: binDir,
      USERPROFILE: root,
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      ProgramFiles: path.join(root, 'Program Files'),
      'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    };
    const deps = { execReg: () => '' };
    const spec = resolveNpmSpawnSpec(['install', '-g', '@tencent-ai/codebuddy-code'], env, deps);
    expect(spec.resolved).toBe(true);
    expect(spec.source).toBe(npmCmd);
    expect(String(spec.command).toLowerCase()).toContain('cmd');
  });

  it('merges registry Path so post-launch installs are discoverable', () => {
    if (process.platform !== 'win32') return;
    const root = makeTempDir('codebuddy-cli-registry-');
    cleanup.push(root);
    const npmDir = path.join(root, 'npm-global');
    const entryDir = path.join(npmDir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin');
    fs.mkdirSync(entryDir, { recursive: true });
    const cmdPath = path.join(npmDir, 'codebuddy.cmd');
    const entryPath = path.join(entryDir, 'codebuddy');
    const nodePath = path.join(npmDir, 'node.exe');
    fs.writeFileSync(cmdPath, '@ECHO off\r\n');
    fs.writeFileSync(entryPath, '#!/usr/bin/env node\nconsole.log("ok")\n');
    fs.writeFileSync(nodePath, 'fake');

    // process PATH 不含 npmDir，仅注册表有 —— 模拟「装完 CLI 后 GUI 仍是旧 PATH」
    const env = {
      Path: 'C:\\Windows\\System32',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: root,
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      ProgramFiles: path.join(root, 'Program Files'),
      'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
    };
    const deps = {
      execReg: (args) => {
        if (args.includes('HKCU\\Environment')) {
          return `Path    REG_SZ    ${npmDir}\r\n`;
        }
        return '';
      },
    };

    const next = withAugmentedPath(env, deps);
    expect(String(next.Path).toLowerCase()).toContain(npmDir.toLowerCase());

    const spec = resolveCodeBuddySpawnSpec(['--version'], env, deps);
    expect(spec.resolved).toBe(true);
    expect(spec.source).toBe(cmdPath);
    expect(spec.command).toBe(nodePath);
    expect(spec.args).toEqual([entryPath, '--version']);
  });
});
