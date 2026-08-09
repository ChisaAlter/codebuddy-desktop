import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createQuitRequestController } = require('../../electron/quit-request-controller.cjs');

function createHarness(options = {}) {
  const timers = [];
  const onTimeout = vi.fn();
  const clearTimer = vi.fn((timer) => {
    if (timer && typeof timer === 'object') timer.cleared = true;
  });
  const controller = createQuitRequestController({
    timeoutMs: options.timeoutMs ?? 2500,
    hardDeadlineMs: options.hardDeadlineMs ?? 6000,
    now: () => 1234,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer,
    onTimeout,
  });
  const runDelay = (delay) => {
    for (const timer of timers) {
      if (timer.delay === delay && !timer.cleared) timer.callback();
    }
  };
  return { controller, clearTimer, onTimeout, runDelay, timers };
}

describe('tray quit request controller', () => {
  it('deduplicates repeated tray exit clicks while a request is pending', () => {
    const { controller } = createHarness();
    const first = controller.begin();
    const second = controller.begin();

    expect(first).toEqual({ started: true, requestId: 'quit-1234-1' });
    expect(second).toEqual({ started: false, requestId: first.requestId });
  });

  it('clears both soft and hard fallbacks when the renderer confirms or cancels', () => {
    const confirmed = createHarness();
    const confirmRequest = confirmed.controller.begin();
    expect(confirmed.controller.confirm(confirmRequest.requestId)).toBe(true);
    confirmed.runDelay(2500);
    confirmed.runDelay(6000);
    expect(confirmed.onTimeout).not.toHaveBeenCalled();
    expect(confirmed.clearTimer).toHaveBeenCalled();

    const cancelled = createHarness();
    const cancelRequest = cancelled.controller.begin();
    expect(cancelled.controller.cancel(cancelRequest.requestId)).toBe(true);
    cancelled.runDelay(2500);
    cancelled.runDelay(6000);
    expect(cancelled.onTimeout).not.toHaveBeenCalled();
  });

  it('disarms only the soft timeout after acknowledge; hard deadline still fires', () => {
    const acknowledged = createHarness();
    const request = acknowledged.controller.begin();

    expect(acknowledged.controller.acknowledge(request.requestId)).toBe(true);
    acknowledged.runDelay(2500);
    expect(acknowledged.onTimeout).not.toHaveBeenCalled();
    expect(acknowledged.controller.hasPending()).toBe(true);

    acknowledged.runDelay(6000);
    expect(acknowledged.onTimeout).toHaveBeenCalledTimes(1);
    expect(acknowledged.onTimeout).toHaveBeenCalledWith(request.requestId);
    expect(acknowledged.controller.hasPending()).toBe(false);
  });

  it('holds the hard deadline during a user dialog and resumes a short deadline after', () => {
    const held = createHarness();
    const request = held.controller.begin();
    expect(held.controller.acknowledge(request.requestId)).toBe(true);
    expect(held.controller.hold(request.requestId)).toBe(true);

    held.runDelay(2500);
    held.runDelay(6000);
    expect(held.onTimeout).not.toHaveBeenCalled();
    expect(held.controller.hasPending()).toBe(true);

    expect(held.controller.resume(request.requestId, 2500)).toBe(true);
    held.runDelay(2500);
    expect(held.onTimeout).toHaveBeenCalledTimes(1);
    expect(held.onTimeout).toHaveBeenCalledWith(request.requestId);
  });

  it('bounds a hold with a fallback deadline so a hung dialog cannot deadlock quit', () => {
    const held = createHarness();
    const request = held.controller.begin();
    expect(held.controller.acknowledge(request.requestId)).toBe(true);
    expect(held.controller.hold(request.requestId)).toBe(true);

    // Soft/hard timers are disarmed; only the hold fallback (120s default) remains.
    held.runDelay(2500);
    held.runDelay(6000);
    expect(held.onTimeout).not.toHaveBeenCalled();
    expect(held.controller.hasPending()).toBe(true);

    held.runDelay(120000);
    expect(held.onTimeout).toHaveBeenCalledTimes(1);
    expect(held.onTimeout).toHaveBeenCalledWith(request.requestId);
    expect(held.controller.hasPending()).toBe(false);
  });

  it('disarms the hold fallback when the dialog resolves via resume or confirm', () => {
    const resumed = createHarness();
    const resumeRequest = resumed.controller.begin();
    expect(resumed.controller.acknowledge(resumeRequest.requestId)).toBe(true);
    expect(resumed.controller.hold(resumeRequest.requestId)).toBe(true);
    expect(resumed.controller.resume(resumeRequest.requestId, 2500)).toBe(true);

    // The hold fallback must not fire after resume; only the resumed hard deadline does.
    resumed.runDelay(120000);
    resumed.runDelay(6000);
    expect(resumed.onTimeout).not.toHaveBeenCalled();
    expect(resumed.controller.hasPending()).toBe(true);
    resumed.runDelay(2500);
    expect(resumed.onTimeout).toHaveBeenCalledTimes(1);
    expect(resumed.controller.hasPending()).toBe(false);

    const confirmed = createHarness();
    const confirmRequest = confirmed.controller.begin();
    expect(confirmed.controller.acknowledge(confirmRequest.requestId)).toBe(true);
    expect(confirmed.controller.hold(confirmRequest.requestId)).toBe(true);
    expect(confirmed.controller.confirm(confirmRequest.requestId)).toBe(true);

    confirmed.runDelay(120000);
    expect(confirmed.onTimeout).not.toHaveBeenCalled();
    expect(confirmed.controller.hasPending()).toBe(false);
  });

  it('fires the soft fallback once when the renderer never responds', () => {
    const { controller, onTimeout, runDelay } = createHarness();
    const request = controller.begin();

    runDelay(2500);
    runDelay(2500);
    runDelay(6000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(request.requestId);
    expect(controller.hasPending()).toBe(false);
  });

  it('uses snappy main-process defaults for tray quit', () => {
    const root = process.cwd();
    const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
    const controllerSource = fs.readFileSync(path.join(root, 'electron', 'quit-request-controller.cjs'), 'utf8');
    const finalSource = fs.readFileSync(path.join(root, 'electron', 'final-exit-controller.cjs'), 'utf8');

    expect(mainSource).toMatch(/timeoutMs:\s*2500/);
    expect(mainSource).toMatch(/hardDeadlineMs:\s*6000/);
    expect(mainSource).toMatch(/holdDeadlineMs:\s*120000/);
    expect(mainSource).toMatch(/forceDelayMs:\s*1200/);
    expect(controllerSource).toMatch(/timeoutMs\s*=\s*Number\.isFinite\(options\.timeoutMs\)\s*\?\s*options\.timeoutMs\s*:\s*2500/);
    expect(controllerSource).toMatch(/hardDeadlineMs\s*=\s*Number\.isFinite\(options\.hardDeadlineMs\)\s*\?\s*options\.hardDeadlineMs\s*:\s*6000/);
    expect(controllerSource).toMatch(
      /holdDeadlineMs\s*=\s*Number\.isFinite\(options\.holdDeadlineMs\)\s*\?\s*options\.holdDeadlineMs\s*:\s*120000/,
    );
    expect(finalSource).toMatch(/trayDelayMs\s*=\s*Number\.isFinite\(options\.trayDelayMs\)\s*\?\s*options\.trayDelayMs\s*:\s*50/);
    expect(finalSource).toMatch(/forceDelayMs\s*=\s*Number\.isFinite\(options\.forceDelayMs\)\s*\?\s*options\.forceDelayMs\s*:\s*1200/);
  });

  it('wires request ids through the main, preload, and renderer layers', () => {
    const root = process.cwd();
    const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
    const appSource = fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8');

    expect(mainSource).toContain("mainWindow.webContents.send('app:quitRequested', { requestId })");
    expect(mainSource).toContain("ipcMain.on('app:cancelQuit'");
    expect(mainSource).toContain("ipcMain.on('window:show'");
    expect(mainSource).toContain("commandLine.includes('--request-quit')");
    expect(mainSource).toContain('beginFinalApplicationExit(`renderer-confirmed:${requestId}`)');
    // Crashed renderers must cancel any pending quit request before reload, so a
    // lost requestId cannot deadlock every later tray/--request-quit attempt.
    expect(mainSource).toMatch(/A crashed renderer can never finish the quit handshake/);
    expect(mainSource).toMatch(/quitRequestController\.cancel\(pendingQuitRequestId\)/);
    expect(preloadSource).toContain(
      "acknowledgeQuit: (requestId) => ipcRenderer.send('app:acknowledgeQuit', requestId)",
    );
    expect(preloadSource).toContain("confirmQuit: (requestId) => ipcRenderer.send('app:confirmQuit', requestId)");
    expect(preloadSource).toContain("cancelQuit: (requestId, reason) => ipcRenderer.send('app:cancelQuit'");
    expect(preloadSource).toContain("windowShow: () => ipcRenderer.send('window:show')");
    expect(preloadSource).toContain("holdQuit: (requestId) => ipcRenderer.send('app:holdQuit', requestId)");
    expect(preloadSource).toContain('resumeQuit:');
    expect(appSource).toContain('window.electronAPI.confirmQuit(requestId)');
    expect(appSource).toContain('window.electronAPI?.acknowledgeQuit?.(requestId)');
    expect(appSource).toContain('window.electronAPI?.cancelQuit?.(requestId');
    expect(appSource).toContain('window.electronAPI?.windowShow?.()');
    expect(appSource).toContain('window.electronAPI?.holdQuit?.(requestId)');
    expect(appSource).toContain('window.electronAPI?.resumeQuit?.(requestId, 2500)');
    expect(appSource).toMatch(/withTimeout\([\s\S]*persistActiveProjectWorkspaceState/);
  });
});
