import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function loadCommonJsModule(path) {
  try {
    return require(path);
  } catch {
    return {};
  }
}

const driver = loadCommonJsModule('../../scripts/test/e2e-driver.cjs');
const evidence = loadCommonJsModule('../../scripts/test/evidence-writer.cjs');
const baseline = loadCommonJsModule('../../scripts/test/e2e-baseline.cjs');
const yaml = require('js-yaml');

function createBaselineFixture(options = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-baseline-fixture-'));
  const contents = options.contents || ['coverage fixture', 'routes fixture', 'security fixture', 'targeted fixture'];
  const sources = contents.map((content, index) => {
    const relativePath = `fixtures/source-${index + 1}.txt`;
    if (options.writeFiles !== false) {
      const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, 'utf8');
    }
    return {
      path: relativePath,
      sha256: crypto.createHash('sha256').update(content).digest('hex').toUpperCase(),
      anchor: `fixture anchor ${index + 1}`,
    };
  });
  return { projectRoot, sources };
}

function processFixture(pid, parentPid, name, overrides = {}) {
  const executablePath = overrides.executablePath || `C:\\Program Files\\CodeBuddy\\${name}`;
  return {
    pid,
    parentPid,
    name,
    executablePath,
    commandLine: overrides.commandLine || `"${executablePath}" --fixture-pid=${pid}`,
    creationTime: overrides.creationTime || `2026-07-11T00:00:${String(pid % 60).padStart(2, '0')}.000Z`,
  };
}

const ownedTreeFixturePath = path.join(
  process.cwd(),
  'scripts',
  'test',
  'fixtures',
  'e2e-owned-tree-fixture.cjs',
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFixtureCondition(predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const intervalMs = options.intervalMs || 25;
  const description = options.description || 'fixture condition';
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) await delay(intervalMs);
  } while (Date.now() < deadline);
  throw new Error(`${description} did not become true within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForFixtureMarker(fixtureDir, name, timeoutMs = 15000) {
  const markerPath = path.join(fixtureDir, `${name}.json`);
  return waitForFixtureCondition(
    () => {
      if (!fs.existsSync(markerPath)) return null;
      return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    },
    { timeoutMs, description: `fixture marker ${name}` },
  );
}

function signalFixture(fixtureDir, name) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, name), `${Date.now()}\n`, 'utf8');
}

async function readExactProcessIdentity(pid, timeoutMs = 15000) {
  return waitForFixtureCondition(
    async () => {
      const listed = (await driver.listSystemProcesses()).map(driver.normalizeProcessEntry);
      const identity = listed.find((entry) => entry.pid === pid);
      return identity?.creationTime && identity?.name && (identity?.executablePath || identity?.commandLine)
        ? identity
        : null;
    },
    { timeoutMs, intervalMs: 75, description: `verifiable identity for pid ${pid}` },
  );
}

async function exactProcessStillExists(identity) {
  const current = (await driver.listSystemProcesses())
    .map(driver.normalizeProcessEntry)
    .find((entry) => entry.pid === identity.pid);
  return Boolean(current && driver.sameProcessIdentity(identity, current));
}

async function waitForExactProcessExit(identity, timeoutMs = 15000) {
  return waitForFixtureCondition(
    async () => !(await exactProcessStillExists(identity)),
    { timeoutMs, intervalMs: 75, description: `exact process ${identity.pid} to exit` },
  );
}

function makeInteractable(element, rect = { x: 10, y: 20, width: 100, height: 40 }) {
  const normalized = {
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON() {
      return this;
    },
  };
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => normalized });
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [normalized] });
  return element;
}

describe('desktop E2E harness public contract', () => {
  it('keeps hosted CI CLI-free and on the cross-platform test gate', () => {
    // R12: ci.yml 上线（push/PR → ubuntu+windows 矩阵 → npm ci + test:gate）。
    // 原断言描述的是一个从未落地的双 job 设计（hosted build-and-test +
    // self-hosted real-desktop-e2e），此前仅靠 ci.yml 不存在的回退分支通过。
    // 核心意图保留：hosted CI 不得安装/依赖 CodeBuddy CLI，也不得跑需要
    // CLI/构建产物的 e2e 套件；真实桌面 E2E 仍留给带 CLI 的真机（TESTING.md）。
    const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const parsed = yaml.load(workflow);
    const gate = parsed.jobs['test-gate'];
    const commands = gate.steps.map((step) => step.run || '').join('\n');

    // CLI-free：不装全局 codebuddy，不固定 CLI 版本。
    expect(workflow).not.toMatch(/npm\s+install[^\n]*(?:--global|-g)[^\n]*codebuddy/i);
    expect(workflow).not.toMatch(/@tencent-ai\/codebuddy-code@\d/);
    // 不跑需要 CLI / 构建产物的套件（真机专属，见 TESTING.md）。
    expect(commands).not.toMatch(/test:e2e|test:packaged|test:perf/);

    // 触发面：push 到 master + PR 指向 master。
    expect(parsed.on.push.branches).toEqual(['master']);
    expect(parsed.on.pull_request.branches).toEqual(['master']);

    // 跨平台矩阵 + 与本地一致的门禁命令。
    expect(gate.strategy.matrix.os).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(commands).toContain('npm ci');
    expect(commands).toContain('npm run test:gate');

    // 供应链加固：第三方 action 必须钉死 40 位 commit SHA，不允许浮动 tag。
    const uses = gate.steps.map((step) => step.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `action must be SHA-pinned: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }

    // Node 版本与 release workflow 保持一致（22）。
    const setupNode = gate.steps.find((step) => /actions\/setup-node@/.test(step.uses || ''));
    expect(Number(setupNode.with['node-version'])).toBe(22);
  });

  it('preserves the original launch then renderer sequence and exposes baseline capture', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

    expect(pkg.scripts['test:e2e:baseline']).toBe('node scripts/test/e2e-baseline.cjs');
    expect(pkg.scripts['test:e2e:unpackaged']).toBe(
      'vite build && node scripts/test/e2e-launch.cjs && node scripts/test/e2e-renderer.cjs',
    );
  });

  it('exports the reusable desktop, CDP, role, screenshot, process, and evidence helpers', () => {
    for (const name of [
      'launchDesktop',
      'findRendererTarget',
      'driveByRole',
      'captureScreenshot',
      'inspectProcesses',
      'cleanupOwned',
      'createRuntimeLayout',
      'cleanupRuntimeDir',
      'requireUsableCodeBuddyStartup',
      'waitForVisibleSettingValue',
      'normalizeProcessEntry',
      'sameProcessIdentity',
      'createOwnedProcessTracker',
      'terminateVerifiedProcess',
      'parsePositiveInteger',
      'execFileAsync',
      'createOverallWatchdog',
      'createSingleFinalizer',
      'createOwnershipCleanupEvidence',
      'finalizeHarnessRun',
      'finalizeUnsafeHarnessFailure',
    ]) {
      expect(driver[name], `${name} must be a public function`).toBeTypeOf('function');
    }
    expect(evidence.writeTaskEvidence, 'writeTaskEvidence must be a public function').toBeTypeOf('function');
    expect(evidence.createTaskRunLayout, 'createTaskRunLayout must be a public function').toBeTypeOf('function');
    expect(evidence.sanitizeEvidenceTree, 'sanitizeEvidenceTree must be a public function').toBeTypeOf('function');
    expect(evidence.scanEvidenceSecrets, 'scanEvidenceSecrets must be a public function').toBeTypeOf('function');
  });

  it('captures a complete immutable baseline inventory as BASELINE_FAIL and NOT_RELEASE_PASS', async () => {
    expect(baseline.BASELINE_STATUS).toBe('BASELINE_FAIL');
    expect(baseline.RELEASE_DISPOSITION).toBe('NOT_RELEASE_PASS');
    expect(baseline.BASELINE_INVENTORY).toHaveLength(38);

    const ids = new Set(baseline.BASELINE_INVENTORY.map((entry) => entry.id));
    for (const required of [
      'packaged-startup-log-path',
      'fixed-cdp-port',
      'shallow-route-gate',
      'remote-navigation-preload',
      'arbitrary-localhost-proxy',
      'arbitrary-git-cwd',
      'global-image-name-kill',
      'password-exposed-to-renderer',
      'auth-disabled-serve-password-contract',
      'backend-cancel-semantic-noop',
      'permission-mode-label-collapse',
      'stalled-sse-reader',
      'stream-owner-lifecycle',
      'terminal-lifecycle-resource-leaks',
      'instances-placeholder-actions',
      'workspace-create-file-no-result',
      'metrics-impossible-disk-units',
      'traces-toolbar-clipping',
      'cjk-mojibake',
    ]) {
      expect(ids, `baseline inventory missing ${required}`).toContain(required);
    }

    for (const entry of baseline.BASELINE_INVENTORY) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        disposition: expect.any(String),
        owningTask: expect.any(String),
        sources: expect.any(Array),
      });
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) {
        expect(source).toMatchObject({ path: expect.any(String), section: expect.any(String) });
      }
    }

    const fixture = createBaselineFixture();
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-baseline-output-'));
    const captured = await baseline.captureBaseline({
      projectRoot: fixture.projectRoot,
      sources: fixture.sources,
      outputRoot,
      timestamp: '2026-07-11T20-00-00-000Z',
    });
    const report = fs.readFileSync(captured.reportPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(captured.jsonPath, 'utf8'));

    expect(json.status).toBe('BASELINE_FAIL');
    expect(json.releaseDisposition).toBe('NOT_RELEASE_PASS');
    expect(json.baselineInventory).toHaveLength(baseline.BASELINE_INVENTORY.length);
    expect(report).toContain('Status: BASELINE_FAIL');
    expect(report).toContain('Release disposition: NOT_RELEASE_PASS');
  });

  it('keeps local baseline source verification strict when an immutable anchor is absent', () => {
    const fixture = createBaselineFixture();
    fs.rmSync(path.join(fixture.projectRoot, ...fixture.sources[0].path.split('/')));

    expect(() => baseline.verifyBaselineSources(fixture.projectRoot, { sources: fixture.sources })).toThrow(
      `Immutable baseline source is missing: ${fixture.sources[0].path}`,
    );
  });

  it('rejects an injected strict baseline fixture whose content no longer matches its manifest hash', () => {
    const fixture = createBaselineFixture();
    fs.writeFileSync(
      path.join(fixture.projectRoot, ...fixture.sources[1].path.split('/')),
      'mutated fixture',
      'utf8',
    );

    expect(() => baseline.verifyBaselineSources(fixture.projectRoot, { sources: fixture.sources })).toThrow(
      `Immutable baseline source hash changed: ${fixture.sources[1].path}`,
    );
  });

  it('captures missing CI anchors only as an explicit unverified registry-only baseline', async () => {
    const fixture = createBaselineFixture({ writeFiles: false });
    const outputRoot = path.join(fixture.projectRoot, 'evidence');
    const captured = await baseline.captureBaseline({
      projectRoot: fixture.projectRoot,
      sources: fixture.sources,
      outputRoot,
      timestamp: '2026-07-11T20-00-02-000Z',
      allowMissingSources: true,
    });
    const report = fs.readFileSync(captured.reportPath, 'utf8');

    expect(captured.data.status).toBe('BASELINE_FAIL');
    expect(captured.data.releaseDisposition).toBe('NOT_RELEASE_PASS');
    expect(captured.data.context.captureMode).toBe('registry-only');
    expect(captured.data.context.verifiedSourceCount).toBe(0);
    expect(captured.data.context.missingSourceCount).toBe(fixture.sources.length);
    expect(captured.data.baselineSources).toHaveLength(fixture.sources.length);
    for (const source of captured.data.baselineSources) {
      expect(source).toMatchObject({ present: false, verified: false, verification: 'not-verified' });
    }
    expect(report).toContain('present: `false`');
    expect(report).toContain('verification: `not-verified`');
    expect(report).not.toContain('verification: `sha256-verified`');
  });

  it('runs the complete unit baseline capture path without a repository .omo directory', async () => {
    const fixture = createBaselineFixture();
    const outputRoot = path.join(fixture.projectRoot, 'unit-output');

    expect(fs.existsSync(path.join(fixture.projectRoot, '.omo'))).toBe(false);
    const captured = await baseline.captureBaseline({
      projectRoot: fixture.projectRoot,
      sources: fixture.sources,
      outputRoot,
      timestamp: '2026-07-11T20-00-03-000Z',
    });

    expect(captured.data.baselineSources.every((entry) => entry.verified)).toBe(true);
    expect(captured.data.baselineSources.map((entry) => entry.path)).toEqual(
      fixture.sources.map((entry) => entry.path),
    );
  });

  it('launchDesktop selects a dynamic CDP port and returns explicit process ownership', async () => {
    const child = new EventEmitter();
    child.pid = 4412;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const spawned = [];
    let trackerStarts = 0;
    const rootIdentity = processFixture(4412, 1, 'fake-electron.exe');

    const launched = await driver.launchDesktop({
      executable: 'fake-electron.exe',
      appArgs: ['.'],
      projectRoot: 'C:\\repo',
      pickPort: async () => 43123,
      listProcesses: async () => [rootIdentity],
      processTrackerFactory: ({ rootIdentity: trackedRoot }) => ({
        async start() {
          trackerStarts += 1;
          return [trackedRoot];
        },
        async stop() {
          return [trackedRoot];
        },
      }),
      spawnImpl(executable, args, options) {
        spawned.push({ executable, args, options });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('--remote-debugging-port=43123');
    expect(spawned[0].args).not.toContain('--remote-debugging-port=9225');
    expect(launched).toMatchObject({ rootPid: 4412, debugPort: 43123 });
    expect(launched.ownership.rootPid).toBe(4412);
    expect(launched.rootIdentity).toMatchObject(rootIdentity);
    expect(launched.processTracker).toBeTruthy();
    expect(trackerStarts).toBe(1);
  });

  it('launchDesktop fails precisely before spawn when a forced CDP port is unavailable', async () => {
    let spawned = false;
    await expect(
      driver.launchDesktop({
        executable: 'fake-electron.exe',
        debugPort: 9225,
        isPortAvailable: async () => false,
        spawnImpl: () => {
          spawned = true;
        },
      }),
    ).rejects.toThrow('Forced CDP port 9225 is unavailable');
    expect(spawned).toBe(false);
  });

  it('launchDesktop rejects an asynchronous spawn error and cleans the partial child/profile once', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-spawn-error-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'spawn-error', label: 'launch' });
    fs.mkdirSync(layout.userDataDir, { recursive: true });
    const child = new EventEmitter();
    child.pid = 5511;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let kills = 0;
    child.kill = () => {
      kills += 1;
      return true;
    };
    child.on('error', () => {});

    await expect(
      driver.launchDesktop({
        executable: 'missing-electron.exe',
        projectRoot,
        userDataDir: layout.userDataDir,
        runtimeRoot: layout.runtimeRoot,
        runtimeDir: layout.runtimeDir,
        runtimeOwnership: layout,
        pickPort: async () => 43123,
        spawnImpl: () => {
          queueMicrotask(() => {
            const error = new Error('spawn missing-electron.exe ENOENT');
            error.code = 'ENOENT';
            child.emit('error', error);
          });
          return child;
        },
      }),
    ).rejects.toThrow(/ENOENT/);

    expect(kills).toBe(1);
    expect(fs.existsSync(layout.runtimeDir)).toBe(false);
  });

  it('launchDesktop stops tracking and verified-cleans late descendants when aborted after tracker start', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-launch-tracker-abort-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'tracker-abort', label: 'launch' });
    fs.mkdirSync(layout.userDataDir, { recursive: true });
    const controller = new AbortController();
    const abortReason = new Error('overall watchdog expired during tracker start');
    const child = new EventEmitter();
    child.pid = 6611;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let fallbackKills = 0;
    child.kill = () => {
      fallbackKills += 1;
      return true;
    };
    const root = processFixture(child.pid, 1, 'fake-electron.exe');
    const lateChild = processFixture(6612, child.pid, 'late-child.exe');
    let trackerStops = 0;
    let cleanupInput = null;
    let caught = null;

    try {
      await driver.launchDesktop({
        executable: 'fake-electron.exe',
        projectRoot,
        userDataDir: layout.userDataDir,
        runtimeRoot: layout.runtimeRoot,
        runtimeDir: layout.runtimeDir,
        runtimeOwnership: layout,
        signal: controller.signal,
        pickPort: async () => 43123,
        listProcesses: async () => [root, lateChild],
        processTrackerFactory: () => ({
          async start() {
            controller.abort(abortReason);
            return [root];
          },
          async stop() {
            trackerStops += 1;
            return [root, lateChild];
          },
        }),
        cleanupOwnedImpl: async (input) => {
          cleanupInput = input;
          return { errors: [], remainingPids: [] };
        },
        spawnImpl: () => {
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(abortReason);
    expect(trackerStops).toBe(1);
    expect(cleanupInput).toMatchObject({ rootPid: child.pid });
    expect(cleanupInput.trackedProcesses).toEqual([root, lateChild]);
    expect(fallbackKills).toBe(0);
    expect(fs.existsSync(layout.runtimeDir)).toBe(false);
  });

  it('launchDesktop preserves the launch error when verified cleanup also fails', async () => {
    const controller = new AbortController();
    const abortReason = new Error('launch cancellation must remain primary');
    const child = new EventEmitter();
    child.pid = 6711;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let fallbackKills = 0;
    child.kill = () => {
      fallbackKills += 1;
      return true;
    };
    const root = processFixture(child.pid, 1, 'fake-electron.exe');
    let caught = null;

    try {
      await driver.launchDesktop({
        executable: 'fake-electron.exe',
        signal: controller.signal,
        pickPort: async () => 43123,
        listProcesses: async () => [root],
        processTrackerFactory: () => ({
          async start() {
            controller.abort(abortReason);
            return [root];
          },
          async stop() {
            return [root];
          },
        }),
        cleanupOwnedImpl: async () => {
          throw new Error('verified cleanup failed');
        },
        spawnImpl: () => {
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(abortReason);
    expect(caught.launchCleanupErrors).toEqual(['verified cleanup failed']);
    expect(fallbackKills).toBe(0);
  });

  it.runIf(process.platform === 'win32')(
    'a real Windows Job kills a child created after the old snapshot and a grandchild created after root exit',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-late-tree-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'late-tree', label: 'launch' });
      const fixtureDir = path.join(layout.runtimeDir, 'owned-fixture');
      const unrelatedDir = path.join(projectRoot, 'unrelated-fixture');
      fs.mkdirSync(layout.userDataDir, { recursive: true });
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.mkdirSync(unrelatedDir, { recursive: true });

      let ownershipController = null;
      let launched = null;
      let unrelated = null;
      let oldSnapshot = [];
      const identities = [];

      try {
        launched = await driver.launchDesktop({
          executable: process.execPath,
          appArgs: [ownedTreeFixturePath, '--role', 'late-root', '--fixture-dir', fixtureDir],
          projectRoot,
          userDataDir: layout.userDataDir,
          runtimeRoot: layout.runtimeRoot,
          runtimeDir: layout.runtimeDir,
          runtimeOwnership: layout,
          pickPort: async () => 43123,
          onOwnershipController(controller) {
            ownershipController = controller;
          },
        });
        await waitForFixtureMarker(fixtureDir, 'late-root-ready');
        identities.push(launched.rootIdentity);

        oldSnapshot = await launched.processTracker.stop();
        expect(oldSnapshot.map((entry) => entry.pid)).toEqual([launched.rootPid]);

        unrelated = spawn(
          process.execPath,
          [ownedTreeFixturePath, '--role', 'survivor', '--fixture-dir', unrelatedDir],
          { cwd: projectRoot, stdio: 'ignore', shell: false, windowsHide: true, detached: false },
        );
        const unrelatedMarker = await waitForFixtureMarker(unrelatedDir, 'survivor-ready');
        const unrelatedIdentity = await readExactProcessIdentity(unrelatedMarker.pid);

        signalFixture(fixtureDir, 'spawn-child');
        const childMarker = await waitForFixtureMarker(fixtureDir, 'late-child-ready');
        const childIdentity = await readExactProcessIdentity(childMarker.pid);
        identities.push(childIdentity);
        await waitForExactProcessExit(launched.rootIdentity);

        signalFixture(fixtureDir, 'spawn-grandchild');
        const grandchildMarker = await waitForFixtureMarker(fixtureDir, 'late-grandchild-ready');
        const grandchildIdentity = await readExactProcessIdentity(grandchildMarker.pid);
        identities.push(grandchildIdentity);

        const cleanup = ownershipController
          ? await ownershipController.close()
          : await driver.cleanupOwned({
              rootPid: launched.rootPid,
              trackedProcesses: oldSnapshot,
            });

        const childStillExists = await exactProcessStillExists(childIdentity);
        const grandchildStillExists = await exactProcessStillExists(grandchildIdentity);
        const unrelatedStillExists = await exactProcessStillExists(unrelatedIdentity);

        expect(childStillExists, 'late child must be killed by Job membership').toBe(false);
        expect(grandchildStillExists, 'post-root-exit grandchild must inherit Job membership').toBe(false);
        expect(unrelatedStillExists, 'unrelated held process must survive Job cleanup').toBe(true);
        expect(ownershipController, 'real Windows launch must publish its Job controller before resolving').toBeTruthy();
        expect(cleanup.ownershipBoundary).toMatchObject({
          kind: 'windows-job',
          rootCreatedSuspended: true,
          rootAssignedBeforeResume: true,
          rootResumed: true,
          killOnJobClose: true,
          jobClosed: true,
        });
        expect(cleanup.remainingVerifiedProcesses).toEqual({
          basis: 'job-active-process-count',
          verified: true,
          count: 0,
          empty: true,
        });
      } finally {
        signalFixture(fixtureDir, 'shutdown');
        signalFixture(unrelatedDir, 'shutdown');
        try {
          await ownershipController?.close?.();
        } catch (_) {
          // The assertions above retain the primary failure; cooperative fixture shutdown prevents leaks on RED.
        }
        for (const identity of identities.filter(Boolean)) {
          try {
            await waitForExactProcessExit(identity, 5000);
          } catch (_) {
            // A still-live identity is reported by the behavior assertions above.
          }
        }
        if (unrelated?.pid) {
          try {
            await waitForExactProcessExit(await readExactProcessIdentity(unrelated.pid, 1000), 5000);
          } catch (_) {
            unrelated.kill();
          }
        }
      }
    },
    70000,
  );

  it.runIf(process.platform === 'win32')(
    'supervisor stdin EOF closes the Job and verifies zero active members',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-eof-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'stdin-eof', label: 'launch' });
      const fixtureDir = path.join(layout.runtimeDir, 'fixture');
      fs.mkdirSync(layout.userDataDir, { recursive: true });
      let ownershipController = null;
      let launched = null;

      try {
        launched = await driver.launchDesktop({
          executable: process.execPath,
          appArgs: [ownedTreeFixturePath, '--role', 'eof-root', '--fixture-dir', fixtureDir],
          projectRoot,
          userDataDir: layout.userDataDir,
          runtimeRoot: layout.runtimeRoot,
          runtimeDir: layout.runtimeDir,
          runtimeOwnership: layout,
          pickPort: async () => 43124,
          onOwnershipController(controller) {
            ownershipController = controller;
          },
        });
        await waitForFixtureMarker(fixtureDir, 'eof-root-ready');
        const rootIdentity = launched.rootIdentity;
        const supervisorExit = new Promise((resolve) => launched.process.once('exit', resolve));

        expect(launched.process.stdin, 'the supervisor control channel must be writable').toBeTruthy();
        launched.process.stdin.end();
        await supervisorExit;

        const cleanup = await ownershipController.close();
        expect(await exactProcessStillExists(rootIdentity)).toBe(false);
        expect(cleanup.ownershipBoundary).toMatchObject({ closeReason: 'stdin-eof', jobClosed: true });
        expect(cleanup.remainingVerifiedProcesses).toMatchObject({ verified: true, count: 0, empty: true });
      } finally {
        signalFixture(fixtureDir, 'shutdown');
        try {
          await ownershipController?.close?.();
        } catch (_) {
          // Cooperative shutdown is the RED fallback.
        }
      }
    },
    30000,
  );

  it.runIf(process.platform === 'win32')(
    'a colliding Job name is rejected without terminating the existing Job member',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-collision-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'collision-first', label: 'launch' });
      const fixtureDir = path.join(layout.runtimeDir, 'fixture');
      const tokenBytes = crypto.randomBytes(16);
      const token = tokenBytes.toString('hex');
      const jobName = `CodeBuddyE2E-${token}`;
      fs.mkdirSync(layout.userDataDir, { recursive: true });
      let ownershipController = null;
      let launched = null;

      try {
        launched = await driver.launchDesktop({
          executable: process.execPath,
          appArgs: [ownedTreeFixturePath, '--role', 'survivor', '--fixture-dir', fixtureDir],
          projectRoot,
          userDataDir: layout.userDataDir,
          runtimeRoot: layout.runtimeRoot,
          runtimeDir: layout.runtimeDir,
          runtimeOwnership: layout,
          pickPort: async () => 43126,
          onOwnershipController(controller) {
            ownershipController = controller;
          },
          randomBytesImpl: () => Buffer.from(tokenBytes),
        });
        await waitForFixtureMarker(fixtureDir, 'survivor-ready');

        const collisionLayout = driver.createRuntimeLayout({
          projectRoot,
          runStamp: 'collision-second',
          label: 'launch',
        });
        const collisionDir = collisionLayout.runtimeDir;
        const sourcePath = path.join(collisionDir, `e2e-job-${token}.cs`);
        const configPath = path.join(collisionDir, `e2e-job-${token}.config.json`);
        const statePath = path.join(collisionDir, `e2e-job-${token}.state.json`);
        const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.cs'));
        fs.writeFileSync(sourcePath, source);
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            version: 2,
            jobName,
            executable: process.execPath,
            arguments: ['-e', 'setInterval(() => {}, 1000)'],
            workingDirectory: projectRoot,
          }),
        );
        const controlPipeToken = '44'.repeat(16);
        const controlPipeName = `CodeBuddyE2E-Control-${controlPipeToken}`;
        const controlPipePath = `\\\\.\\pipe\\${controlPipeName}`;
        const controlServer = net.createServer();
        controlServer.maxConnections = 1;
        await new Promise((resolve, reject) => {
          controlServer.once('error', reject);
          controlServer.listen(controlPipePath, resolve);
        });
        const controlConnected = new Promise((resolve, reject) => {
          controlServer.once('error', reject);
          controlServer.once('connection', (socket) => {
            socket.on('error', () => {});
            controlServer.close();
            resolve(socket);
          });
        });
        const collisionProcess = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.ps1'),
            '-Mode',
            'Supervise',
            '-RuntimeDir',
            collisionDir,
            '-ConfigPath',
            configPath,
            '-StatePath',
            statePath,
            '-SourcePath',
            sourcePath,
            '-SourceSha256',
            crypto.createHash('sha256').update(source).digest('hex'),
            '-JobName',
            jobName,
            '-ControlPipeName',
            controlPipeName,
            '-ControlPipeToken',
            controlPipeToken,
            '-ProjectRoot',
            collisionLayout.projectRoot,
            '-ProjectRealRoot',
            collisionLayout.projectRealRoot,
            '-MarkerPath',
            collisionLayout.markerPath,
            '-MarkerToken',
            collisionLayout.markerToken,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
        const collisionStdout = [];
        const collisionStderr = [];
        collisionProcess.stdout.on('data', (chunk) => collisionStdout.push(String(chunk)));
        collisionProcess.stderr.on('data', (chunk) => collisionStderr.push(String(chunk)));
        const controlSocket = await controlConnected;
        controlSocket.end('CLOSE\n');
        const collision = await new Promise((resolve, reject) => {
          collisionProcess.once('error', reject);
          collisionProcess.once('exit', (status, signal) => {
            resolve({
              status,
              signal,
              stdout: collisionStdout.join(''),
              stderr: collisionStderr.join(''),
            });
          });
        });

        expect(collision.status, collision.stderr || collision.signal).toBe(2);
        expect(await exactProcessStillExists(launched.rootIdentity), 'the pre-existing Job member must survive').toBe(true);
      } finally {
        signalFixture(fixtureDir, 'shutdown');
        await ownershipController?.close?.();
      }
    },
    35000,
  );

  it.runIf(process.platform === 'win32')(
    'rejects a forged Windows Job control pipe token before root creation',
    () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-forged-pipe-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'forged-pipe', label: 'launch' });
      const token = '11'.repeat(16);
      const forgedToken = '22'.repeat(16);
      const sourcePath = path.join(layout.runtimeDir, `e2e-job-${token}.cs`);
      const configPath = path.join(layout.runtimeDir, `e2e-job-${token}.config.json`);
      const statePath = path.join(layout.runtimeDir, `e2e-job-${token}.state.json`);
      const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.cs'));
      fs.mkdirSync(layout.runtimeDir, { recursive: true });
      fs.writeFileSync(sourcePath, source);
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 2,
          jobName: `CodeBuddyE2E-${token}`,
          executable: process.execPath,
          arguments: ['-e', 'setInterval(() => {}, 1000)'],
          workingDirectory: projectRoot,
        }),
      );

      const run = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.ps1'),
          '-Mode',
          'Supervise',
          '-RuntimeDir',
          layout.runtimeDir,
          '-ConfigPath',
          configPath,
          '-StatePath',
          statePath,
          '-SourcePath',
          sourcePath,
          '-SourceSha256',
          crypto.createHash('sha256').update(source).digest('hex'),
          '-JobName',
          `CodeBuddyE2E-${token}`,
          '-ControlPipeName',
          `CodeBuddyE2E-Control-${forgedToken}`,
          '-ControlPipeToken',
          token,
          '-ProjectRoot',
          layout.projectRoot,
          '-ProjectRealRoot',
          layout.projectRealRoot,
          '-MarkerPath',
          layout.markerPath,
          '-MarkerToken',
          layout.markerToken,
        ],
        { input: 'CLOSE\n', encoding: 'utf8', timeout: 20000, windowsHide: true },
      );

      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/ControlPipeName must match the control ownership token/i);
      expect(fs.existsSync(statePath), 'forged control token must be rejected before boundary creation').toBe(false);
    },
    30000,
  );

  it('bounds Windows Job control-pipe commands before parsing them', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.cs'),
      'utf8',
    );

    expect(source).toContain('CONTROL_COMMAND_MAXIMUM_CHARACTERS');
    expect(source).toContain('ReadBoundedControl(controlReader)');
    expect(source).not.toContain('controlReader.ReadLine()');
  });

  it.runIf(process.platform === 'win32')(
    'JS collision recovery rejects the second launch without terminating the existing Job member',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-js-job-collision-'));
      const firstLayout = driver.createRuntimeLayout({
        projectRoot,
        runStamp: 'collision-first',
        label: 'launch',
      });
      const secondLayout = driver.createRuntimeLayout({
        projectRoot,
        runStamp: 'collision-second',
        label: 'launch',
      });
      const firstFixtureDir = path.join(firstLayout.runtimeDir, 'fixture');
      const secondFixtureDir = path.join(secondLayout.runtimeDir, 'fixture');
      const deterministicRandomBytes = (size) => Buffer.alloc(size, 0x11);
      let first = null;
      let secondError = null;

      try {
        first = await driver.launchDesktop({
          executable: process.execPath,
          appArgs: [ownedTreeFixturePath, '--role', 'survivor', '--fixture-dir', firstFixtureDir],
          projectRoot,
          userDataDir: firstLayout.userDataDir,
          runtimeRoot: firstLayout.runtimeRoot,
          runtimeDir: firstLayout.runtimeDir,
          runtimeOwnership: firstLayout,
          pickPort: async () => 43127,
          randomBytesImpl: deterministicRandomBytes,
        });
        await waitForFixtureMarker(firstFixtureDir, 'survivor-ready');

        try {
          await driver.launchDesktop({
            executable: process.execPath,
            appArgs: [ownedTreeFixturePath, '--role', 'survivor', '--fixture-dir', secondFixtureDir],
            projectRoot,
            userDataDir: secondLayout.userDataDir,
            runtimeRoot: secondLayout.runtimeRoot,
            runtimeDir: secondLayout.runtimeDir,
            runtimeOwnership: secondLayout,
            pickPort: async () => 43128,
            randomBytesImpl: deterministicRandomBytes,
          });
        } catch (error) {
          secondError = error;
        }

        expect(secondError).toBeInstanceOf(Error);
        expect(secondError.message).toMatch(/collision|ownership was established/i);
        expect(secondError.ownershipBoundary).toMatchObject({
          jobCreatedNew: false,
          collisionDetected: true,
          established: false,
          rootCreatedSuspended: false,
          rootAssignedBeforeResume: false,
          supervisorReaped: true,
        });
        expect(secondError.remainingVerifiedProcesses).toEqual({
          basis: 'controller-no-owned-root',
          verified: true,
          count: 0,
          empty: true,
        });

        expect(
          await exactProcessStillExists(first.rootIdentity),
          'the existing Job member must survive second-launch JS recovery',
        ).toBe(true);

        const cleanup = await first.ownershipController.close();
        expect(await exactProcessStillExists(first.rootIdentity)).toBe(false);
        expect(cleanup.ownershipBoundary).toMatchObject({
          jobCreatedNew: true,
          collisionDetected: false,
          established: true,
          rootAssignedBeforeResume: true,
          closeReason: 'controller-close',
          supervisorReaped: true,
        });
        expect(cleanup.remainingVerifiedProcesses).toMatchObject({ verified: true, count: 0, empty: true });
      } finally {
        signalFixture(firstFixtureDir, 'shutdown');
        signalFixture(secondFixtureDir, 'shutdown');
        try {
          await first?.ownershipController?.close?.();
        } catch (_) {
          // The behavior assertion retains the primary RED while the fixture receives cooperative shutdown.
        }
      }
    },
    45000,
  );

  it.runIf(process.platform === 'win32')(
    'parent exit inherits the target environment without persisting it in runtime files',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-parent-exit-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'parent-exit', label: 'launch' });
      const fixtureDir = path.join(layout.runtimeDir, 'fixture');
      const identityPath = path.join(projectRoot, 'env-root-identity.json');
      const driverPath = path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs');
      const sentinel = 'present-only-in-env';
      const probe = `
        const fs = require('node:fs');
        const path = require('node:path');
        const driver = require(${JSON.stringify(driverPath)});
        const fixture = ${JSON.stringify(ownedTreeFixturePath)};
        const fixtureDir = ${JSON.stringify(fixtureDir)};
        const identityPath = ${JSON.stringify(identityPath)};
        const layout = ${JSON.stringify(layout)};
        const waitForMarker = async () => {
          const target = path.join(fixtureDir, 'env-root-ready.json');
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('env-root marker timed out');
        };
        (async () => {
          const launched = await driver.launchDesktop({
            executable: process.execPath,
            appArgs: [fixture, '--role', 'env-root', '--fixture-dir', fixtureDir],
            projectRoot: ${JSON.stringify(projectRoot)},
            userDataDir: layout.userDataDir,
            runtimeRoot: layout.runtimeRoot,
            runtimeDir: layout.runtimeDir,
            runtimeOwnership: layout,
            pickPort: async () => 43129,
            env: { CODEBUDDY_E2E_SENTINEL: process.env.CODEBUDDY_E2E_SENTINEL },
          });
          const marker = await waitForMarker();
          if (marker.sentinelPresent !== true) throw new Error('target did not inherit sentinel');
          fs.writeFileSync(identityPath, JSON.stringify(launched.rootIdentity), 'utf8');
          process.exit(0);
        })().catch((error) => {
          process.stderr.write(String(error && (error.stack || error.message || error)));
          process.exit(24);
        });
      `;
      let rootIdentity = null;

      try {
        const probeProcess = spawn(process.execPath, ['-e', probe], {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, CODEBUDDY_E2E_SENTINEL: sentinel },
        });
        const stdout = [];
        const stderr = [];
        probeProcess.stdout.on('data', (chunk) => stdout.push(String(chunk)));
        probeProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));
        const run = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            probeProcess.kill();
            reject(new Error('parent-exit probe timed out after 25000ms'));
          }, 25000);
          probeProcess.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          probeProcess.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        expect(run.code, stderr.join('') || stdout.join('') || run.signal).toBe(0);
        rootIdentity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
        await waitForExactProcessExit(rootIdentity, 15000);

        const marker = await waitForFixtureMarker(fixtureDir, 'env-root-ready');
        expect(marker).toMatchObject({ sentinelPresent: true });
        const statePath = await waitForFixtureCondition(
          () => {
            if (!fs.existsSync(layout.runtimeDir)) return null;
            const name = fs.readdirSync(layout.runtimeDir).find((entry) => /^e2e-job-[0-9a-f]{32}\.state\.json$/.test(entry));
            return name ? path.join(layout.runtimeDir, name) : null;
          },
          { description: 'parent-exit supervisor state' },
        );
        let lastState = null;
        let finalState = null;
        try {
          finalState = await waitForFixtureCondition(
            () => {
              lastState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              return lastState.closeReason === 'stdin-eof' && lastState.zeroVerified === true &&
                lastState.activeProcessCount === 0 && lastState.jobClosed === true
                ? lastState
                : null;
            },
            { description: 'parent-exit zero-member proof' },
          );
        } catch (error) {
          error.message += `; last state=${JSON.stringify(lastState)}`;
          throw error;
        }
        expect(finalState).toMatchObject({ closeReason: 'stdin-eof', activeProcessCount: 0, zeroVerified: true });

        const configPath = statePath.replace(/\.state\.json$/, '.config.json');
        const jsonPaths = [];
        const collectJson = (directory) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) collectJson(entryPath);
            else if (entry.isFile() && entry.name.endsWith('.json')) jsonPaths.push(entryPath);
          }
        };
        collectJson(layout.runtimeDir);
        const privacyViolations = jsonPaths
          .filter((jsonPath) => {
            const contents = fs.readFileSync(jsonPath, 'utf8');
            return contents.includes(sentinel) || /"environment"\s*:/i.test(contents) ||
              /"commandLine"\s*:/i.test(contents);
          })
          .map((jsonPath) => path.relative(layout.runtimeDir, jsonPath).replaceAll('\\', '/'));
        expect(privacyViolations, 'runtime JSON must not persist inherited environment data').toEqual([]);
        expect(fs.existsSync(configPath), 'validated launch config must be removed before target resume').toBe(false);
      } finally {
        signalFixture(fixtureDir, 'shutdown');
        if (rootIdentity && (await exactProcessStillExists(rootIdentity))) {
          await waitForExactProcessExit(rootIdentity, 5000);
        }
        if (fs.existsSync(layout.runtimeDir)) await driver.cleanupRuntimeDir(layout);
      }
    },
    40000,
  );

  it.runIf(process.platform === 'win32')(
    'hard watchdog expiry exits nonzero only after synchronous Job termination leaves no fixture descendant',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-job-hard-timeout-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'hard-timeout', label: 'launch' });
      const fixtureDir = path.join(layout.runtimeDir, 'fixture');
      const identitiesPath = path.join(projectRoot, 'owned-identities.json');
      const emergencyPath = path.join(projectRoot, 'emergency-result.json');
      fs.mkdirSync(layout.userDataDir, { recursive: true });
      const driverPath = path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs');
      const probe = `
        const fs = require('node:fs');
        const path = require('node:path');
        const driver = require(${JSON.stringify(driverPath)});
        const fixture = ${JSON.stringify(ownedTreeFixturePath)};
        const fixtureDir = ${JSON.stringify(fixtureDir)};
        const identitiesPath = ${JSON.stringify(identitiesPath)};
        const emergencyPath = ${JSON.stringify(emergencyPath)};
        const layout = ${JSON.stringify(layout)};
        const waitFor = async (name) => {
          const target = path.join(fixtureDir, name + '.json');
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('missing marker ' + name);
        };
        (async () => {
          let ownershipController = null;
          await driver.launchDesktop({
            executable: process.execPath,
            appArgs: [fixture, '--role', 'hard-root', '--fixture-dir', fixtureDir],
            projectRoot: ${JSON.stringify(projectRoot)},
            userDataDir: layout.userDataDir,
            runtimeRoot: layout.runtimeRoot,
            runtimeDir: layout.runtimeDir,
            runtimeOwnership: layout,
            pickPort: async () => 43125,
            onOwnershipController(controller) { ownershipController = controller; },
          });
          const markers = await Promise.all([
            waitFor('hard-root-ready'),
            waitFor('hard-child-ready'),
            waitFor('hard-grandchild-ready'),
          ]);
          const pids = new Set(markers.map((entry) => entry.pid));
          const identities = (await driver.listSystemProcesses())
            .map(driver.normalizeProcessEntry)
            .filter((entry) => pids.has(entry.pid));
          if (identities.length !== 3) throw new Error('could not capture all hard-tree identities');
          fs.writeFileSync(identitiesPath, JSON.stringify(identities), 'utf8');
          const watchdog = driver.createOverallWatchdog({
            timeoutMs: 60,
            cancellationGraceMs: 60,
            label: 'hard Job probe',
          });
          try {
            await watchdog.run(() => new Promise(() => {}));
          } catch (error) {
            if (error.finalizationSafe !== false) throw error;
            const emergency = ownershipController ? ownershipController.emergencyClose() : null;
            fs.writeFileSync(emergencyPath, JSON.stringify(emergency), 'utf8');
            process.exit(23);
          }
        })().catch((error) => {
          process.stderr.write(String(error && (error.stack || error.message || error)));
          process.exit(24);
        });
      `;

      let identities = [];
      let exitsVerified = false;
      try {
        const probeProcess = spawn(process.execPath, ['-e', probe], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        probeProcess.stdout.on('data', (chunk) => stdout.push(String(chunk)));
        probeProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)));
        const run = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            probeProcess.kill('SIGKILL');
            reject(
              new Error(
                'hard watchdog probe did not exit within 25000ms; stdout=' +
                  stdout.join('') +
                  '; stderr=' +
                  stderr.join(''),
              ),
            );
          }, 25000);
          probeProcess.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          probeProcess.once('exit', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stdout: stdout.join(''), stderr: stderr.join('') });
          });
        });
        expect(run.status, run.stderr || run.signal || run.stdout).toBe(23);
        identities = JSON.parse(fs.readFileSync(identitiesPath, 'utf8'));
        const emergency = JSON.parse(fs.readFileSync(emergencyPath, 'utf8'));
        expect(emergency.remainingVerifiedProcesses).toMatchObject({ verified: true, count: 0, empty: true });
        const remainingProcesses = (await driver.listSystemProcesses()).map(driver.normalizeProcessEntry);
        for (const identity of identities) {
          const current = remainingProcesses.find((entry) => entry.pid === identity.pid);
          expect(
            Boolean(current && driver.sameProcessIdentity(identity, current)),
            `owned fixture pid ${identity.pid} survived hard exit`,
          ).toBe(false);
        }
        exitsVerified = true;
      } finally {
        signalFixture(fixtureDir, 'shutdown');
        if (!exitsVerified) {
          for (const identity of identities) {
            try {
              await waitForExactProcessExit(identity, 5000);
            } catch (_) {
              // The assertion above reports an emergency-cleanup failure.
            }
          }
        }
      }
    },
    35000,
  );

  it('creates sanitized ownership evidence even when launch never returns a launched object', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-launch-evidence-'));
    const runtimeRoot = path.join(projectRoot, '.omo', 'e2e-runtime', 'failed-launch');
    const secret = 'cleanup-secret-value';
    const error = new Error('primary launch failure');
    error.launchCleanupErrors = [
      `secondary cleanup failed at ${runtimeRoot}; password=${secret}`,
    ];
    error.ownershipBoundary = {
      kind: 'windows-job',
      established: true,
      rootCreatedSuspended: true,
      rootAssignedBeforeResume: true,
      rootResumed: false,
      killOnJobClose: true,
      jobClosed: true,
      commandLine: `fake.exe --password ${secret}`,
      environment: { CODEBUDDY_TOKEN: secret },
    };
    error.remainingVerifiedProcesses = {
      basis: 'job-active-process-count',
      verified: true,
      count: 0,
      empty: true,
    };

    const cleanup = driver.createOwnershipCleanupEvidence({
      error,
      launched: null,
      ownershipController: null,
      cleanup: null,
      sanitize(value) {
        return evidence.sanitizeText(value, {
          redactionMap: { [runtimeRoot]: '[runtime-root]', [projectRoot]: '[project-root]' },
        });
      },
    });
    const written = await evidence.writeTaskEvidence({
      rootDir: path.join(projectRoot, 'evidence'),
      pathRoot: projectRoot,
      redactionMap: { [runtimeRoot]: '[runtime-root]', [projectRoot]: '[project-root]' },
      taskId: 'task-1',
      runLabel: 'failed-launch',
      status: 'FAIL',
      cleanup,
    });
    const combined = fs.readFileSync(written.jsonPath, 'utf8') + fs.readFileSync(written.reportPath, 'utf8');

    expect(written.data.cleanup).toMatchObject({
      launchCleanupErrors: [expect.stringContaining('[redacted]')],
      ownershipBoundary: {
        kind: 'windows-job',
        rootAssignedBeforeResume: true,
        rootResumed: false,
        jobClosed: true,
      },
      remainingVerifiedProcesses: {
        basis: 'job-active-process-count',
        verified: true,
        count: 0,
        empty: true,
      },
    });
    expect(combined).not.toContain(secret);
    expect(combined.toLowerCase()).not.toContain(runtimeRoot.toLowerCase());
    expect(combined).not.toMatch(/commandLine|environment/i);
  });

  it('finalizeHarnessRun selects unsafe finalization exactly once and excludes the normal finalizer', async () => {
    const hardError = new Error('hard watchdog failure');
    hardError.finalizationSafe = false;
    const calls = { normal: 0, unsafe: 0 };

    const outcome = await driver.finalizeHarnessRun({
      error: hardError,
      normalFinalizer() {
        calls.normal += 1;
        return 'normal-result';
      },
      unsafeFinalizer(receivedError) {
        calls.unsafe += 1;
        expect(receivedError).toBe(hardError);
        return 'unsafe-result';
      },
    });

    expect(calls).toEqual({ normal: 0, unsafe: 1 });
    expect(outcome).toMatchObject({ branch: 'unsafe', result: 'unsafe-result', finalizerError: null });
  });

  it('finalizeHarnessRun selects normal finalization exactly once for success and ordinary errors', async () => {
    for (const error of [null, new Error('ordinary failure')]) {
      const calls = { normal: 0, unsafe: 0 };
      const outcome = await driver.finalizeHarnessRun({
        error,
        normalFinalizer(receivedError) {
          calls.normal += 1;
          expect(receivedError).toBe(error);
          return error ? 'normal-error-result' : 'normal-success-result';
        },
        unsafeFinalizer() {
          calls.unsafe += 1;
          return 'unsafe-result';
        },
      });

      expect(calls).toEqual({ normal: 1, unsafe: 0 });
      expect(outcome).toMatchObject({
        branch: 'normal',
        result: error ? 'normal-error-result' : 'normal-success-result',
        finalizerError: null,
      });
    }
  });

  it('finalizeHarnessRun reports selected-branch rejection without falling through', async () => {
    for (const branch of ['unsafe', 'normal']) {
      const selectedError = new Error(`${branch} finalizer rejected`);
      const hardError = new Error('watchdog outcome');
      if (branch === 'unsafe') hardError.finalizationSafe = false;
      const calls = { normal: 0, unsafe: 0 };
      const outcome = await driver.finalizeHarnessRun({
        error: hardError,
        normalFinalizer() {
          calls.normal += 1;
          if (branch === 'normal') throw selectedError;
          throw new Error('normal finalizer must not run');
        },
        unsafeFinalizer() {
          calls.unsafe += 1;
          if (branch === 'unsafe') throw selectedError;
          throw new Error('unsafe finalizer must not run');
        },
      });

      expect(calls).toEqual(branch === 'unsafe' ? { normal: 0, unsafe: 1 } : { normal: 1, unsafe: 0 });
      expect(outcome).toMatchObject({ branch, result: null });
      expect(outcome.finalizerError).toBe(selectedError);
    }
  });

  it('unsafe finalization closes the Job, removes runtime, and writes frozen sanitized FAIL evidence', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-unsafe-finalize-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'hard-failure', label: 'launch' });
    const runDir = path.join(projectRoot, '.omo', 'evidence', 'unsafe-hard-failure');
    const secret = 'unsafe-environment-secret';
    fs.mkdirSync(layout.userDataDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(layout.runtimeDir, 'e2e-job-deadbeefdeadbeefdeadbeefdeadbeef.config.json'),
      JSON.stringify({ environment: { CODEBUDDY_TOKEN: secret } }),
      'utf8',
    );

    const hardError = new Error(`hard watchdog failed at ${layout.runtimeDir}; password=${secret}`);
    hardError.code = 'E_WATCHDOG_CANCELLATION_GRACE';
    hardError.finalizationSafe = false;
    const events = [];
    const cleanupProof = {
      ownershipBoundary: {
        kind: 'windows-job',
        established: true,
        rootCreatedSuspended: true,
        rootAssignedBeforeResume: true,
        rootResumed: true,
        killOnJobClose: true,
        jobClosed: true,
        closeReason: 'emergency-terminate',
        rootPid: 4321,
        win32Error: 0,
        supervisorReaped: false,
      },
      remainingVerifiedProcesses: {
        basis: 'job-active-process-count',
        verified: true,
        count: 0,
        empty: true,
      },
    };
    const ownershipController = {
      emergencyClose() {
        events.push('emergency-close');
        expect(fs.existsSync(layout.runtimeDir)).toBe(true);
        return cleanupProof;
      },
      snapshot() {
        return cleanupProof;
      },
    };
    const mutableContext = { harness: 'unit-hard-failure', marker: 'original' };
    const workspacePlaceholderTargets = [
      path.join(process.cwd(), '[project-root]'),
      path.join(process.cwd(), '[root]'),
    ];
    const expectedControlPaths = {
      runDir: path.resolve(runDir),
      pathRoot: path.resolve(projectRoot),
    };
    let receivedControlPaths = null;

    for (const placeholderTarget of workspacePlaceholderTargets) {
      expect(fs.existsSync(placeholderTarget), `${placeholderTarget} must not pre-exist`).toBe(false);
    }

    const pending = driver.finalizeUnsafeHarnessFailure({
      error: hardError,
      ownershipController,
      runtimeOwnership: layout,
      runtimeRoot: layout.runtimeRoot,
      runtimeDir: layout.runtimeDir,
      evidenceOptions: {
        runDir,
        pathRoot: projectRoot,
        redactionMap: {
          [layout.runtimeRoot]: '[runtime-root]',
          [projectRoot]: '[project-root]',
        },
        taskId: 'task-1',
        runLabel: 'unsafe-unit',
        timestamp: 'unsafe-unit-run',
        context: mutableContext,
        command: 'unit unsafe finalization',
      },
      writeEvidence(payload) {
        receivedControlPaths = { runDir: payload.runDir, pathRoot: payload.pathRoot };
        if (
          receivedControlPaths.runDir !== expectedControlPaths.runDir ||
          receivedControlPaths.pathRoot !== expectedControlPaths.pathRoot
        ) {
          throw new Error('unsafe finalization attempted to use sanitized placeholders as filesystem paths');
        }
        return evidence.writeTaskEvidence(payload);
      },
      sanitize(value) {
        return evidence.sanitizeText(value, {
          redactionMap: {
            [layout.runtimeRoot]: '[runtime-root]',
            [projectRoot]: '[project-root]',
          },
        });
      },
    });
    mutableContext.marker = `mutated-${secret}`;
    const outcome = await pending;

    const reportPath = path.join(runDir, 'report.md');
    const jsonPath = path.join(runDir, 'evidence.json');
    expect(fs.existsSync(reportPath), 'unsafe finalization must not return without a report').toBe(true);
    expect(fs.existsSync(jsonPath), 'unsafe finalization must not return without JSON evidence').toBe(true);
    expect(fs.existsSync(layout.runtimeDir), 'environment-bearing runtime must be removed').toBe(false);
    expect(events).toEqual(['emergency-close']);
    const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const combined = fs.readFileSync(reportPath, 'utf8') + fs.readFileSync(jsonPath, 'utf8');
    expect(written).toMatchObject({
      status: 'FAIL',
      failure: {
        code: 'E_WATCHDOG_CANCELLATION_GRACE',
        finalizationSafe: false,
        runtimeRemoval: { attempted: true, removed: true },
      },
      cleanup: {
        remainingVerifiedProcesses: { basis: 'job-active-process-count', verified: true, count: 0, empty: true },
      },
    });
    expect(written.context.marker).toBe('original');
    expect(receivedControlPaths).toEqual(expectedControlPaths);
    expect(outcome?.evidenceWriteError).toBeNull();
    expect(combined).not.toContain(secret);
    expect(combined.toLowerCase()).not.toContain(projectRoot.toLowerCase());
    expect(combined).not.toMatch(/commandLine|environment/i);
    for (const placeholderTarget of workspacePlaceholderTargets) {
      expect(fs.existsSync(placeholderTarget), `${placeholderTarget} must never become an evidence target`).toBe(false);
    }
    expect(evidence.scanEvidenceSecrets({ roots: [runDir] })).toMatchObject({ count: 0, paths: [] });
  });

  it('unsafe finalization returns deduplicated stderr-safe cleanup failures when evidence writing fails', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-unsafe-stderr-'));
    const runtimeRoot = path.join(projectRoot, 'owned-runtime-root');
    const runtimeDir = path.join(projectRoot, 'outside-owned-runtime');
    const runDir = path.join(projectRoot, 'evidence');
    const secret = 'stderr-cleanup-secret';
    const sharedFailure = `Job close failed at ${projectRoot}; token=${secret}`;
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    const hardError = new Error('hard watchdog failure');
    hardError.finalizationSafe = false;

    const outcome = await driver.finalizeUnsafeHarnessFailure({
      error: hardError,
      runtimeRoot,
      runtimeDir,
      ownershipController: {
        emergencyClose() {
          return {
            ownershipBoundary: {
              kind: 'windows-job',
              established: true,
              rootCreatedSuspended: true,
              rootAssignedBeforeResume: true,
              rootResumed: true,
              killOnJobClose: true,
              jobClosed: true,
              closeReason: 'emergency-terminate',
              rootPid: 4321,
              win32Error: 5,
              supervisorReaped: false,
            },
            remainingVerifiedProcesses: {
              basis: 'job-active-process-count',
              verified: false,
              count: 1,
              empty: false,
            },
            launchCleanupErrors: [sharedFailure, sharedFailure],
            errors: [
              sharedFailure,
              {
                pid: 4321,
                error: `member cleanup failed at ${runtimeDir}; password=${secret}`,
                commandLine: `unsafe.exe --token=${secret}`,
                environment: { CODEBUDDY_TOKEN: secret },
              },
            ],
          };
        },
      },
      evidenceOptions: {
        runDir,
        pathRoot: projectRoot,
        redactionMap: {
          [runtimeDir]: '[runtime-dir]',
          [runtimeRoot]: '[runtime-root]',
          [projectRoot]: '[project-root]',
        },
      },
      writeEvidence() {
        throw new Error(`writer failed at ${os.homedir()}; password=${secret}`);
      },
      sanitize(value) {
        return evidence.sanitizeText(value, {
          redactionMap: {
            [runtimeDir]: '[runtime-dir]',
            [runtimeRoot]: '[runtime-root]',
            [projectRoot]: '[project-root]',
          },
        });
      },
    });

    const combined = outcome.stderrFailures.join('\n');
    expect(outcome.evidencePaths).toBeNull();
    expect(outcome.evidenceWriteError).toContain('unsafe failure evidence write failed');
    expect(outcome.stderrFailures).toContain('Job close failed at [project-root]; token=[redacted]');
    expect(outcome.stderrFailures.filter((entry) => entry === 'Job close failed at [project-root]; token=[redacted]')).toHaveLength(1);
    expect(outcome.stderrFailures).toContain('pid 4321: member cleanup failed at [runtime-dir]; password=[redacted]');
    expect(outcome.stderrFailures.some((entry) => entry.startsWith('runtime cleanup failed:'))).toBe(true);
    expect(outcome.stderrFailures.some((entry) => entry.startsWith('unsafe failure evidence write failed:'))).toBe(true);
    expect(combined).not.toContain(secret);
    expect(combined.toLowerCase()).not.toContain(projectRoot.toLowerCase());
    expect(combined.toLowerCase()).not.toContain(os.homedir().toLowerCase());
    expect(combined).not.toMatch(/commandLine|environment/i);
    expect(Object.isFrozen(outcome.stderrFailures)).toBe(true);
  });

  it('execFileAsync applies bounded timeout, kill signal, buffer, and hidden-window defaults', async () => {
    let captured = null;
    const result = await driver.execFileAsync('fake-command', ['--version'], {
      execFileImpl(file, args, options, callback) {
        captured = { file, args, options };
        callback(null, '1.2.3', '');
      },
    });

    expect(result.stdout).toBe('1.2.3');
    expect(captured.options).toMatchObject({
      timeout: expect.any(Number),
      killSignal: 'SIGKILL',
      maxBuffer: expect.any(Number),
      windowsHide: true,
    });
    expect(captured.options.timeout).toBeGreaterThan(0);
  });

  it('retries transient Windows process enumeration failures before returning a verified snapshot', async () => {
    let attempts = 0;
    const retryDelays = [];
    const processes = await driver.listSystemProcesses({
      platform: 'win32',
      processListRetries: 3,
      processListRetryDelayMs: 9,
      waitImpl: async (delayMs) => retryDelays.push(delayMs),
      execFileImpl(file, args, options, callback) {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('Get-CimInstance is temporarily unavailable');
          error.code = 'E_CIM_TRANSIENT';
          callback(error, '', 'temporary provider failure');
          return;
        }
        callback(
          null,
          JSON.stringify({
            pid: 4321,
            parentPid: 100,
            name: 'node.exe',
            executablePath: 'C:\\Program Files\\nodejs\\node.exe',
            commandLine: 'node fixture.cjs',
            creationTime: '2026-07-18T00:00:00.000Z',
          }),
          '',
        );
      },
    });

    expect(attempts).toBe(3);
    expect(retryDelays).toEqual([9, 9]);
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ pid: 4321, parentPid: 100, name: 'node.exe' });
  });
  it('Windows termination verifies and kills through one held Process object without exposing identity secrets', async () => {
    const identity = processFixture(4321, 100, 'codebuddy.exe', {
      commandLine: '"C:\\CodeBuddy\\codebuddy.exe" --serve --password top-secret-value',
    });
    let captured = null;

    const result = await driver.terminateVerifiedProcess(identity, {
      platform: 'win32',
      execFileImpl(file, args, options, callback) {
        captured = { file, args, options };
        callback(null, '{"status":"terminated"}', '');
      },
    });

    const invocation = [captured.file, ...captured.args].join(' ');
    const script = captured.args[captured.args.indexOf('-Command') + 1];
    expect(result).toMatchObject({ status: 'terminated', pid: 4321 });
    expect(captured.file.toLowerCase()).toContain('powershell');
    expect(script).toContain('[System.Diagnostics.Process]::GetProcessById');
    expect(script).toContain('$process.Handle');
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('$process.Kill()');
    expect(invocation.toLowerCase()).not.toContain('taskkill');
    expect(invocation).not.toContain('top-secret-value');
  });

  it('Windows termination binds constrained identity values through real PowerShell without killing a process', async () => {
    if (process.platform !== 'win32') return;
    const missingPid = 2147483647;
    const identity = processFixture(missingPid, 1, 'missing-codebuddy.exe');

    const result = await driver.terminateVerifiedProcess(identity, { platform: 'win32' });

    expect(result).toMatchObject({ pid: missingPid, status: 'not-found' });
  });

  it('Windows termination rejects an injection-shaped creation time before launching PowerShell', async () => {
    const identity = processFixture(4321, 100, 'codebuddy.exe', {
      creationTime: "$(Write-Output 'injected')",
    });
    let launchedPowerShell = false;

    await expect(
      driver.terminateVerifiedProcess(identity, {
        platform: 'win32',
        execFileImpl() {
          launchedPowerShell = true;
          throw new Error('PowerShell must not launch');
        },
      }),
    ).rejects.toThrow(/start time must be a positive integer/i);
    expect(launchedPowerShell).toBe(false);
  });

  it('Windows termination rejects a PID outside the PowerShell Process API range before launch', async () => {
    const identity = processFixture(2147483648, 100, 'codebuddy.exe');
    let launchedPowerShell = false;

    await expect(
      driver.terminateVerifiedProcess(identity, {
        platform: 'win32',
        execFileImpl() {
          launchedPowerShell = true;
          throw new Error('PowerShell must not launch');
        },
      }),
    ).rejects.toThrow(/PID must be a positive 32-bit integer/i);
    expect(launchedPowerShell).toBe(false);
  });

  it('watchdog aborts cooperatively and does not settle until main acknowledges cancellation', async () => {
    const timers = [];
    let clears = 0;
    const watchdog = driver.createOverallWatchdog({
      timeoutMs: 1234,
      cancellationGraceMs: 500,
      label: 'unit harness',
      setTimeoutImpl(callback, delay) {
        timers.push({ callback, delay });
        return { unref() {} };
      },
      clearTimeoutImpl() {
        clears += 1;
      },
    });
    const events = [];
    let acknowledgeAbort = null;
    const run = watchdog.run((signal) => {
      events.push('main-started');
      return new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            events.push('abort-seen');
            acknowledgeAbort = () => {
              events.push('main-settled');
              resolve();
            };
          },
          { once: true },
        );
      });
    });
    let settled = false;
    const observed = run.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );

    await Promise.resolve();
    expect(timers[0].delay).toBe(1234);
    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual(['main-started', 'abort-seen']);
    expect(settled).toBe(false);
    acknowledgeAbort();
    const outcome = await observed;
    expect(outcome.error).toMatchObject({ finalizationSafe: true });
    expect(outcome.error.message).toContain('unit harness exceeded overall watchdog 1234ms');
    expect(events).toEqual(['main-started', 'abort-seen', 'main-settled']);
    watchdog.stop();
    expect(clears).toBeGreaterThanOrEqual(1);
  });

  it('watchdog reports a hard unsafe-finalization failure when cancellation grace expires', async () => {
    const timers = [];
    let receivedSignal = null;
    const watchdog = driver.createOverallWatchdog({
      timeoutMs: 100,
      cancellationGraceMs: 25,
      label: 'uncooperative harness',
      setTimeoutImpl(callback, delay) {
        timers.push({ callback, delay });
        return { unref() {} };
      },
      clearTimeoutImpl() {},
    });
    const observed = watchdog.run((signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    await Promise.resolve();
    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    expect(receivedSignal?.aborted).toBe(true);
    expect(timers[1].delay).toBe(25);
    timers[1].callback();

    const outcome = await observed;
    expect(outcome.error).toMatchObject({
      code: 'E_WATCHDOG_CANCELLATION_GRACE',
      finalizationSafe: false,
    });
    expect(outcome.error.message).toContain('did not settle within cancellation grace 25ms');
  });

  it('watchdog timers stay referenced until an otherwise handle-free hung task fails hard', () => {
    const driverPath = path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs');
    const script = `
      const { createOverallWatchdog } = require(${JSON.stringify(driverPath)});
      createOverallWatchdog({ timeoutMs: 20, cancellationGraceMs: 20, label: 'liveness probe' })
        .run(() => new Promise(() => {}))
        .catch((error) => {
          process.stderr.write(String(error.code) + ':' + String(error.finalizationSafe));
          process.exitCode = 7;
        });
    `;

    const run = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });

    expect(run.status).toBe(7);
    expect(run.stderr).toContain('E_WATCHDOG_CANCELLATION_GRACE:false');
  });

  it('cleanup settle waits keep an otherwise handle-free process alive through post-verification', () => {
    const driverPath = path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs');
    const script = `
      const driver = require(${JSON.stringify(driverPath)});
      const identity = {
        pid: 7001,
        parentPid: 1,
        name: 'owned.exe',
        executablePath: 'C:\\\\Owned\\\\owned.exe',
        commandLine: 'C:\\\\Owned\\\\owned.exe --test',
        creationTime: '2026-07-11T00:00:01.000Z'
      };
      let processes = [identity];
      driver.cleanupOwned({
        rootPid: identity.pid,
        trackedProcesses: [identity],
        listProcesses: async () => processes,
        terminateProcess: async () => {
          processes = [];
          return { status: 'terminated' };
        },
        settleMs: 20
      }).then((result) => {
        process.stderr.write('CLEANUP_SETTLED:' + result.errors.length + ':' + result.remainingPids.length);
        process.exitCode = 7;
      });
    `;

    const run = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });

    expect(run.status).toBe(7);
    expect(run.stderr).toContain('CLEANUP_SETTLED:0:0');
  });

  it('unrefs only the recurring ownership-sampling interval', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs'), 'utf8');
    const unrefs = [...script.matchAll(/\.unref(?:\?\.)?\(\)/g)];

    expect(unrefs).toHaveLength(1);
    expect(script.slice(Math.max(0, unrefs[0].index - 400), unrefs[0].index)).toContain('setIntervalImpl');
  });

  it('createSingleFinalizer executes once', async () => {

    let finalizerCalls = 0;
    const finalize = driver.createSingleFinalizer(async (value) => {
      finalizerCalls += 1;
      return value;
    });
    const first = finalize('first');
    const second = finalize('second');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('first');
    expect(finalizerCalls).toBe(1);
  });

  it('classifies an auth-disabled CLI port without a password as an explicit baseline blocker', () => {
    const cleanProfileLog = 'CodeBuddy runtime ready project=project-1 port=61069';
    expect(driver.requireUsableCodeBuddyStartup(cleanProfileLog)).toMatchObject({ state: 'ready', port: 61069 });
  });

  it('findRendererTarget selects the packaged renderer instead of an unrelated page target', async () => {
    const target = await driver.findRendererTarget({
      port: 43123,
      expectedUrl: /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/,
      timeoutMs: 50,
      listTargets: async () => [
        {
          type: 'page',
          title: 'DevTools',
          url: 'devtools://devtools/bundled/inspector.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/devtools',
        },
        {
          type: 'page',
          title: 'CodeBuddy Desktop',
          url: 'http://127.0.0.1:54321/index.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/codebuddy',
        },
      ],
    });

    expect(target.title).toBe('CodeBuddy Desktop');
    expect(target.url).toBe('http://127.0.0.1:54321/index.html');
    expect(target.debugPort).toBe(43123);
  });

  it('connectCdp closes a never-opened socket and removes abort listeners exactly once on timeout', async () => {
    let socket = null;
    class NeverOpeningSocket {
      constructor() {
        socket = this;
        this.listeners = new Map();
        this.registered = new Map();
        this.closeCalls = 0;
      }

      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        if (!this.registered.has(type)) this.registered.set(type, []);
        this.listeners.get(type).add(listener);
        this.registered.get(type).push(listener);
      }

      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
      }

      close() {
        this.closeCalls += 1;
      }
    }
    const abortListeners = new Set();
    const registeredAbortListeners = [];
    const signal = {
      aborted: false,
      reason: new Error('late abort'),
      addEventListener(type, listener) {
        if (type !== 'abort') return;
        abortListeners.add(listener);
        registeredAbortListeners.push(listener);
      },
      removeEventListener(type, listener) {
        if (type === 'abort') abortListeners.delete(listener);
      },
    };

    await expect(
      driver.connectCdp(
        { webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/never-opens' },
        { WebSocketImpl: NeverOpeningSocket, connectTimeoutMs: 5, signal },
      ),
    ).rejects.toThrow('CDP WebSocket open timed out after 5ms');

    expect(socket.closeCalls).toBe(1);
    expect(abortListeners.size).toBe(0);
    expect(socket.listeners.get('open')?.size || 0).toBe(0);
    expect(socket.listeners.get('error')?.size || 0).toBe(0);

    socket.registered.get('error')[0]({ message: 'late error' });
    registeredAbortListeners[0]();
    socket.registered.get('open')[0]();
    expect(socket.closeCalls).toBe(1);
  });

  it('connectCdp closes an opened socket when either CDP initialization command fails', async () => {
    for (const failingMethod of ['Runtime.enable', 'Page.enable']) {
      let socket = null;
      class InitializationSocket {
        constructor() {
          socket = this;
          this.listeners = new Map();
          this.sentMethods = [];
          this.closeCalls = 0;
          queueMicrotask(() => this.emit('open', {}));
        }

        addEventListener(type, listener) {
          if (!this.listeners.has(type)) this.listeners.set(type, new Set());
          this.listeners.get(type).add(listener);
        }

        removeEventListener(type, listener) {
          this.listeners.get(type)?.delete(listener);
        }

        emit(type, event) {
          for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
        }

        send(payload) {
          const message = JSON.parse(payload);
          this.sentMethods.push(message.method);
          queueMicrotask(() => {
            this.emit('message', {
              data: JSON.stringify(
                message.method === failingMethod
                  ? { id: message.id, error: { message: `${failingMethod} refused` } }
                  : { id: message.id, result: {} },
              ),
            });
          });
        }

        close() {
          this.closeCalls += 1;
          this.emit('close', {});
        }
      }
      const abortListeners = new Set();
      const signal = {
        aborted: false,
        addEventListener(type, listener) {
          if (type === 'abort') abortListeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'abort') abortListeners.delete(listener);
        },
      };

      await expect(
        driver.connectCdp(
          { webSocketDebuggerUrl: `ws://127.0.0.1:43123/devtools/page/fail-${failingMethod}` },
          { WebSocketImpl: InitializationSocket, commandTimeoutMs: 100, signal },
        ),
      ).rejects.toThrow(`CDP ${failingMethod} failed: ${failingMethod} refused`);

      expect(socket.sentMethods).toEqual(
        failingMethod === 'Runtime.enable' ? ['Runtime.enable'] : ['Runtime.enable', 'Page.enable'],
      );
      expect(socket.closeCalls).toBe(1);
      expect(abortListeners.size).toBe(0);
    }
  });

  it('driveByRole clicks a visible control through its accessible role and name', async () => {
    document.body.innerHTML = '<button type="button" aria-label="刷新路由">ignored glyph</button>';
    let clicks = 0;
    const button = makeInteractable(document.querySelector('button'));
    button.addEventListener('click', () => {
      clicks += 1;
    });
    const sends = [];

    const result = await driver.driveByRole(
      {
        evaluate: async (expression) => globalThis.eval(expression),
        send: async (method, params) => {
          sends.push({ method, params });
          if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
            const target = document.querySelector('[data-codebuddy-e2e-target]');
            target?.click();
            target?.setAttribute('data-codebuddy-e2e-click-ack', target.getAttribute('data-codebuddy-e2e-click-token'));
          }
          return {};
        },
      },
      {
        role: 'button',
        name: '刷新路由',
        action: 'click',
        timeoutMs: 25,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      role: 'button',
      name: '刷新路由',
      dispatched: true,
      dispatch: 'cdp-native',
      clickAcknowledged: true,
      trustedClick: true,
    });
    expect(sends.map((entry) => entry.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(clicks).toBe(1);
  });

  it('driveByRole can invoke a visible control for deterministic route coverage', async () => {
    document.body.innerHTML = '<button type="button" aria-label="实例">route</button>';
    let clicks = 0;
    const button = makeInteractable(document.querySelector('button'));
    button.addEventListener('click', () => {
      clicks += 1;
    });

    const result = await driver.driveByRole(
      { evaluate: async (expression) => globalThis.eval(expression) },
      {
        role: 'button',
        name: '实例',
        action: 'invoke',
        timeoutMs: 25,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      name: '实例',
      action: 'invoke',
    });
    expect(clicks).toBe(1);
  });

  it('driveByRole rejects three successful CDP mouse commands without a trusted target acknowledgment', async () => {
    document.body.innerHTML = '<button type="button" aria-label="无确认点击">click</button>';
    makeInteractable(document.querySelector('button'));
    const sends = [];

    await expect(
      driver.driveByRole(
        {
          evaluate: async (expression) => globalThis.eval(expression),
          send: async (method, params) => {
            sends.push({ method, params });
            return {};
          },
        },
        {
          role: 'button',
          name: '无确认点击',
          action: 'click',
          timeoutMs: 25,
          clickAckTimeoutMs: 0,
        },
      ),
    ).rejects.toThrow(/trusted click acknowledgment/i);

    expect(sends.map((entry) => entry.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('driveRoutes treats an already-active route as navigation success without clicking it again', async () => {
    let sendCount = 0;
    const client = {
      async evaluate(expression) {
        if (expression.includes('window.location.hash')) {
          return { hash: '', status: '对话' };
        }
        return {
          ok: true,
          role: 'textbox',
          name: '从一个想法开始...',
          action: 'assert',
          tag: 'textarea',
          disabled: false,
          targetId: 'composer',
          x: 50,
          y: 50,
          width: 100,
          height: 40,
        };
      },
      async send() {
        sendCount += 1;
      },
    };

    const results = await driver.driveRoutes(client, {
      routes: [{
        route: 'chat',
        navLabel: '对话',
        expected: { role: 'textbox', name: '从一个想法开始...' },
      }],
      routeTimeoutMs: 100,
    });

    expect(results).toHaveLength(1);
    expect(results[0].navigation).toMatchObject({ ok: true, action: 'already-active' });
    expect(sendCount).toBe(0);
  });

  it('parsePositiveInteger rejects skipped or fractional chat coverage values', () => {
    for (const value of ['', '0', '-1', '1.5', 'abc', Number.NaN, 0, -2, 2.25]) {
      expect(() =>
        driver.parsePositiveInteger(value, {
          name: 'CODEBUDDY_E2E_CHAT_ROUNDS',
          defaultValue: 10,
        }),
      ).toThrow(/CODEBUDDY_E2E_CHAT_ROUNDS must be a positive integer/);
    }
    expect(driver.parsePositiveInteger(undefined, { name: 'rounds', defaultValue: 10 })).toBe(10);
    expect(driver.parsePositiveInteger('1', { name: 'rounds', defaultValue: 10 })).toBe(1);
    expect(driver.parsePositiveInteger(3, { name: 'rounds', defaultValue: 10 })).toBe(3);
  });

  it('driveByRole rejects controls hidden by an ancestor', async () => {
    document.body.innerHTML =
      '<section style="display: none"><button type="button" aria-label="隐藏按钮">hidden</button></section>';

    await expect(
      driver.driveByRole(
        {
          evaluate: async (expression) => globalThis.eval(expression),
        },
        {
          role: 'button',
          name: '隐藏按钮',
          timeoutMs: 0,
          intervalMs: 0,
        },
      ),
    ).rejects.toThrow('Visible button control named "隐藏按钮" was not found');
  });

  it('driveByRole refuses disabled, aria-disabled, inert, pointer-blocked, and zero-size click targets', async () => {
    document.body.innerHTML = `
      <button aria-label="disabled" disabled>disabled</button>
      <button aria-label="aria-disabled" aria-disabled="true">aria-disabled</button>
      <section inert><button aria-label="inert">inert</button></section>
      <button aria-label="pointer" style="pointer-events:none">pointer</button>
      <button aria-label="zero">zero</button>
    `;
    for (const button of document.querySelectorAll('button:not([aria-label="zero"])')) makeInteractable(button);
    let clicks = 0;
    for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => (clicks += 1));
    const sends = [];
    const client = {
      evaluate: async (expression) => globalThis.eval(expression),
      send: async (...args) => sends.push(args),
    };

    for (const name of ['disabled', 'aria-disabled', 'inert', 'pointer', 'zero']) {
      await expect(
        driver.driveByRole(client, { role: 'button', name, action: 'click', timeoutMs: 0, intervalMs: 0 }),
      ).rejects.toThrow(/not interactable|was not found/i);
    }

    expect(clicks).toBe(0);
    expect(sends).toEqual([]);
  });

  it('driveByRole refuses to fill a readonly textbox', async () => {
    document.body.innerHTML = '<textarea aria-label="readonly editor" readonly>original</textarea>';
    const textbox = makeInteractable(document.querySelector('textarea'));

    await expect(
      driver.driveByRole(
        { evaluate: async (expression) => globalThis.eval(expression), send: async () => ({}) },
        {
          role: 'textbox',
          name: 'readonly editor',
          action: 'fill',
          value: 'changed',
          timeoutMs: 0,
          intervalMs: 0,
        },
      ),
    ).rejects.toThrow(/readonly|not interactable/i);
    expect(textbox.value).toBe('original');
  });

  it('waits for a visible non-empty setting value and then for a distinct replacement', async () => {
    document.body.innerHTML = `
      <section style="display:none">
        <div class="settings-row">
          <div class="settings-label">会话 ID</div>
          <div class="settings-control">hidden-stale...</div>
        </div>
      </section>
      <div class="settings-row">
        <div class="settings-label">会话 ID</div>
        <div class="settings-control"></div>
      </div>
    `;
    const visibleControl = document.querySelector('body > .settings-row .settings-control');
    let reads = 0;
    const client = {
      evaluate: async (expression) => {
        reads += 1;
        if (reads === 2) visibleControl.textContent = 'session-a...';
        if (reads === 4) visibleControl.textContent = 'session-b...';
        return globalThis.eval(expression);
      },
    };

    const initial = await driver.waitForVisibleSettingValue(client, '会话 ID', {
      timeoutMs: 50,
      intervalMs: 0,
    });
    const replacement = await driver.waitForVisibleSettingValue(client, '会话 ID', {
      timeoutMs: 50,
      intervalMs: 0,
      accept: (value) => value !== initial,
    });

    expect(initial).toBe('session-a...');
    expect(replacement).toBe('session-b...');
    expect(reads).toBe(4);
  });

  it('captureScreenshot persists the exact PNG bytes returned by CDP', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-shot-'));
    const screenshotPath = path.join(tempDir, 'route.png');
    const png = Buffer.from('fake-png-bytes');
    const calls = [];

    const result = await driver.captureScreenshot(
      {
        send: async (method, params) => {
          calls.push({ method, params });
          return { data: png.toString('base64') };
        },
      },
      screenshotPath,
    );

    expect(calls[0].method).toBe('Page.captureScreenshot');
    expect(fs.readFileSync(screenshotPath)).toEqual(png);
    expect(result).toMatchObject({ path: screenshotPath, bytes: png.length });
  });

  it('captureScreenshot masks whole-page identity data during capture and restores the DOM afterward', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-private-shot-'));
    const screenshotPath = path.join(tempDir, 'route.png');
    const projectRoot = 'C:\\Users\\privacy-user\\Documents\\Private Project';
    const userHome = 'C:\\Users\\privacy-user';
    const userName = 'privacy.user@example.test';
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const png = Buffer.from('privacy-safe-png');
    document.body.innerHTML = `
      <aside role="navigation" aria-label="Main navigation">
        <div class="workspace-info" title="${projectRoot}" data-workspace="${projectRoot}">
          <span>工作区</span><span>${projectRoot}</span>
        </div>
        <section data-session-history aria-label="会话历史">
          <button title="${sessionId}">Private roadmap title</button>
        </section>
        <div class="sidebar-user-section" title="Private Account Alias">Private Account Alias</div>
      </aside>
      <main>
        <section class="log-output" aria-label="Logs">
          <pre>RAW-LOG-PRIVATE-LINE session=${sessionId.slice(0, 12)}...</pre>
        </section>
        <input
          value="${projectRoot}"
          placeholder="Open ${userHome}"
          title="${userName}"
          data-session-id="${sessionId}"
        />
        <select title="${userName}">
          <option value="${sessionId}">${userName} ${sessionId}</option>
        </select>
        <div data-note="mailto:${userName}">
          Backup ${userName} at D:\\Private\\secret.txt for ${sessionId}.
        </div>
      </main>
    `;
    const input = document.querySelector('input');
    const option = document.querySelector('option');
    const originalHtml = document.body.innerHTML;
    const originalInputValue = input.value;
    const originalOptionValue = option.value;
    let domDuringCapture = '';
    const client = {
      evaluate: async (expression) => globalThis.eval(expression),
      send: async (method) => {
        expect(method).toBe('Page.captureScreenshot');
        domDuringCapture = JSON.stringify({
          html: document.body.innerHTML,
          text: document.body.textContent,
          controls: [...document.querySelectorAll('input, textarea, select, option')].map((element) => ({
            value: element.value,
            placeholder: element.placeholder,
            title: element.title,
            attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
          })),
        });
        return { data: png.toString('base64') };
      },
    };

    const result = await driver.captureScreenshot(client, screenshotPath, {
      privacy: { sensitiveValues: [projectRoot, userHome, userName, sessionId] },
    });

    for (const sensitive of [
      projectRoot,
      userHome,
      userName,
      sessionId,
      sessionId.slice(0, 12),
      'Private roadmap title',
      'Private Account Alias',
      'RAW-LOG-PRIVATE-LINE',
      'D:\\Private\\secret.txt',
    ]) {
      expect(domDuringCapture).not.toContain(sensitive);
    }
    expect(domDuringCapture).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    expect(domDuringCapture).not.toMatch(/[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}/i);
    expect(result.privacy).toMatchObject({ privacyVerified: true, remaining: 0 });
    expect(Object.keys(result.privacy).sort()).toEqual(
      ['privacyVerified', 'redactedNodes', 'redactedAttributes', 'redactedRanges', 'remaining'].sort(),
    );
    expect(result.privacy.redactedNodes).toBeGreaterThan(0);
    expect(result.privacy.redactedAttributes).toBeGreaterThan(0);
    expect(result.privacy.redactedRanges).toBeGreaterThan(0);
    expect(document.body.innerHTML).toBe(originalHtml);
    expect(input.value).toBe(originalInputValue);
    expect(option.value).toBe(originalOptionValue);
  });

  it('captureScreenshot restores masked content when CDP capture rejects', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-private-shot-error-'));
    const screenshotPath = path.join(tempDir, 'route.png');
    const projectRoot = 'C:\\Users\\privacy-user\\Documents\\Rejected Capture';
    const sessionId = '913e4567-e89b-42d3-a456-426614174999';
    document.body.innerHTML = `
      <aside>
        <div class="sidebar-user-section">Failure Account Alias</div>
        <section data-session-history><span>Rejected history title ${sessionId}</span></section>
      </aside>
      <main class="log-output"><pre>REJECTED-RAW-LOG ${projectRoot}</pre></main>
      <input value="${sessionId}" title="${projectRoot}" />
    `;
    const input = document.querySelector('input');
    const originalHtml = document.body.innerHTML;
    const originalInputValue = input.value;
    let domDuringCapture = '';

    await expect(
      driver.captureScreenshot(
        {
          evaluate: async (expression) => globalThis.eval(expression),
          send: async () => {
            domDuringCapture = `${document.body.textContent}\n${document.body.innerHTML}\n${input.value}`;
            throw new Error('synthetic capture failure');
          },
        },
        screenshotPath,
        { privacy: { sensitiveValues: [projectRoot, sessionId] } },
      ),
    ).rejects.toThrow('synthetic capture failure');

    expect(domDuringCapture).not.toContain(projectRoot);
    expect(domDuringCapture).not.toContain(sessionId);
    expect(domDuringCapture).not.toContain('Failure Account Alias');
    expect(domDuringCapture).not.toContain('Rejected history title');
    expect(domDuringCapture).not.toContain('REJECTED-RAW-LOG');
    expect(document.body.innerHTML).toBe(originalHtml);
    expect(input.value).toBe(originalInputValue);
    expect(fs.existsSync(screenshotPath)).toBe(false);
  });

  it('captureScreenshot cannot write after its shared harness signal is aborted', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-aborted-shot-'));
    const screenshotPath = path.join(tempDir, 'late.png');
    const controller = new AbortController();
    let releaseCapture = null;
    const capture = driver.captureScreenshot(
      {
        send: async () =>
          new Promise((resolve) => {
            releaseCapture = () => resolve({ data: Buffer.from('late-png').toString('base64') });
          }),
      },
      screenshotPath,
      { signal: controller.signal },
    );

    await Promise.resolve();
    controller.abort(new Error('unit harness timed out'));
    releaseCapture();

    await expect(capture).rejects.toThrow('unit harness timed out');
    expect(fs.existsSync(screenshotPath)).toBe(false);
  });

  it('inspectProcesses and cleanupOwned restrict cleanup to the launched process tree', async () => {
    let processes = [
      processFixture(100, 1, 'CodeBuddy Desktop.exe'),
      processFixture(101, 100, 'electron.exe'),
      processFixture(102, 101, 'node.exe'),
      processFixture(900, 1, 'unrelated-electron.exe'),
    ];
    const listProcesses = async () => processes;

    const inspected = await driver.inspectProcesses({ rootPid: 100, listProcesses });
    expect(inspected.ownedPids).toEqual([100, 101, 102]);

    const killed = [];
    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      listProcesses,
      trackedProcesses: processes.slice(0, 3),
      terminateProcess: async ({ pid }) => {
        killed.push(pid);
        processes = processes.filter((entry) => entry.pid !== pid);
        return { status: 'terminated' };
      },
      settleMs: 0,
    });
    expect(killed).toEqual([102, 101, 100]);
    expect(cleaned.errors).toEqual([]);
    expect(cleaned.ownedPids).not.toContain(900);
  });

  it('cleanupOwned post-verifies the initial owned PID set even when taskkill reports success', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const child = processFixture(101, 100, 'node.exe');
    const unrelated = processFixture(900, 1, 'unrelated-node.exe');
    let processes = [root, child, unrelated];
    const killed = [];
    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root, child],
      listProcesses: async () => processes,
      terminateProcess: async ({ pid }) => {
        killed.push(pid);
        if (pid === 100) processes = processes.filter((entry) => entry.pid !== 100);
        return { status: 'terminated' };
      },
      settleMs: 0,
    });

    expect(killed).toEqual([101, 100]);
    expect(cleaned.initialOwnedPids).toEqual([100, 101]);
    expect(cleaned.remainingPids).toEqual([101]);
    expect(cleaned.errors).toEqual([{ pid: 101, error: 'owned process still running after cleanup' }]);
    expect(killed).not.toContain(900);
  });

  it('cleanupOwned treats termination races as clean when the owned tree is gone on verification', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const child = processFixture(101, 100, 'node.exe');
    let processes = [root, child];
    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root, child],
      listProcesses: async () => processes,
      terminateProcess: async () => {
        processes = [];
        throw new Error('verified termination reported a transient child exit');
      },
      settleMs: 0,
    });

    expect(cleaned.remainingPids).toEqual([]);
    expect(cleaned.errors).toEqual([]);
    expect(cleaned.warnings[0]).toContain('transient child exit');
  });

  it('refuses to kill a reused PID whose stable identity no longer matches the tracked process', async () => {
    const tracked = processFixture(101, 100, 'node.exe', { creationTime: '2026-07-11T00:00:01.000Z' });
    const reused = processFixture(101, 1, 'unrelated.exe', {
      executablePath: 'C:\\Other\\unrelated.exe',
      commandLine: 'C:\\Other\\unrelated.exe --serve',
      creationTime: '2026-07-11T00:05:00.000Z',
    });
    const killed = [];

    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [tracked],
      listProcesses: async () => [reused],
      terminateProcess: async () => ({ status: 'identity-mismatch' }),
      settleMs: 0,
    });

    expect(killed).toEqual([]);
    expect(cleaned.errors).toEqual([
      { pid: 101, error: 'ownership mismatch: PID now belongs to a different process identity' },
    ]);
  });

  it('cannot kill an unrelated replacement swapped after cleanup inspection but before held-object termination', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const replacement = processFixture(100, 1, 'unrelated.exe', {
      executablePath: 'C:\\Other\\unrelated.exe',
      commandLine: 'C:\\Other\\unrelated.exe --serve',
      creationTime: '2026-07-11T00:05:00.000Z',
    });
    let processes = [root];
    let replacementKilled = false;

    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root],
      listProcesses: async () => processes,
      terminateProcess: async () => {
        processes = [replacement];
        return { status: 'unsafe-identity-swap' };
      },
      settleMs: 0,
    });

    expect(replacementKilled).toBe(false);
    expect(processes).toEqual([replacement]);
    expect(cleaned.errors).toEqual(
      expect.arrayContaining([
        {
          pid: 100,
          error: 'unsafe termination refused: held process identity no longer matched the PID snapshot',
        },
      ]),
    );
  });

  it('contains no PID-only taskkill fallback in the desktop driver', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs'), 'utf8');
    expect(script.toLowerCase()).not.toContain('taskkill.exe');
  });

  it('cleans an exactly tracked child after the root exits and the child is reparented', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const child = processFixture(101, 100, 'node.exe');
    let processes = [{ ...child, parentPid: 1 }];
    const killed = [];

    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root, child],
      listProcesses: async () => processes,
      terminateProcess: async ({ pid }) => {
        if (!processes.some((entry) => entry.pid === pid)) return { status: 'not-found' };
        killed.push(pid);
        processes = processes.filter((entry) => entry.pid !== pid);
        return { status: 'terminated' };
      },
      settleMs: 0,
    });

    expect(killed).toEqual([101]);
    expect(cleaned.errors).toEqual([]);
  });

  it('adopts and cleans a late descendant observed under the exact tracked root at cleanup start', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const lateChild = processFixture(999, 100, 'late-child.exe');
    let processes = [root, lateChild];
    const killed = [];

    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root],
      listProcesses: async () => processes,
      terminateProcess: async ({ pid }) => {
        killed.push(pid);
        processes = processes.filter((entry) => entry.pid !== pid);
        return { status: 'terminated' };
      },
      settleMs: 0,
    });

    expect(killed).toEqual([999, 100]);
    expect(cleaned.errors).toEqual([]);
    expect(cleaned.initialOwnedPids).toEqual([100, 999]);
    expect(cleaned.remainingPids).toEqual([]);
    expect(processes.map((entry) => entry.pid)).not.toContain(999);
  });

  it('fails loudly without killing an identity-incomplete late descendant', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const lateChild = {
      pid: 999,
      parentPid: 100,
      name: 'late-child.exe',
      executablePath: '',
      commandLine: '',
      creationTime: '2026-07-11T00:09:59.000Z',
    };
    let processes = [root, lateChild];
    const killed = [];

    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      trackedProcesses: [root],
      listProcesses: async () => processes,
      terminateProcess: async ({ pid }) => {
        killed.push(pid);
        processes = processes.filter((entry) => entry.pid !== pid);
        return { status: 'terminated' };
      },
      settleMs: 0,
    });

    expect(killed).toEqual([100]);
    expect(processes.map((entry) => entry.pid)).toContain(999);
    expect(cleaned.errors).toEqual([
      { pid: 999, error: 'unverifiable late descendant: process identity is incomplete' },
    ]);
  });

  it('returns an unverifiable ownership error when the root is gone and no tracked identity exists', async () => {
    const cleaned = await driver.cleanupOwned({
      rootPid: 100,
      listProcesses: async () => [],
      trackedProcesses: [],
      terminateProcess: async () => {
        throw new Error('must not kill');
      },
      settleMs: 0,
    });

    expect(cleaned.errors).toEqual([
      { pid: 100, error: 'unverifiable ownership: root missing and no tracked process identity is available' },
    ]);
  });

  it('tracks exact descendants across reparenting and releases its sampling timer', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const child = processFixture(101, 100, 'node.exe');
    let reads = 0;
    let tick = null;
    let clears = 0;
    const tracker = driver.createOwnedProcessTracker({
      rootIdentity: root,
      listProcesses: async () => {
        reads += 1;
        return reads === 1 ? [root, child] : [{ ...child, parentPid: 1 }];
      },
      setIntervalImpl(callback) {
        tick = callback;
        return { unref() {} };
      },
      clearIntervalImpl() {
        clears += 1;
      },
    });

    await tracker.start();
    await tick();
    const snapshot = await tracker.stop();

    expect(snapshot.map((entry) => entry.pid).sort()).toEqual([100, 101]);
    expect(snapshot.find((entry) => entry.pid === 101).creationTime).toBe(child.creationTime);
    expect(clears).toBe(1);
  });

  it('uses a one-second interval, skips overlapping ticks, and performs one final tracker sample', async () => {
    const root = processFixture(100, 1, 'CodeBuddy Desktop.exe');
    const lateChild = processFixture(101, 100, 'late-child.exe');
    let reads = 0;
    let tick = null;
    let configuredIntervalMs = null;
    let resolveSlowSample = null;
    const tracker = driver.createOwnedProcessTracker({
      rootIdentity: root,
      listProcesses: async () => {
        reads += 1;
        if (reads === 2) {
          return new Promise((resolve) => {
            resolveSlowSample = () => resolve([root]);
          });
        }
        return reads === 3 ? [root, lateChild] : [root];
      },
      setIntervalImpl(callback, intervalMs) {
        tick = callback;
        configuredIntervalMs = intervalMs;
        return { unref() {} };
      },
      clearIntervalImpl() {},
    });

    await tracker.start();
    tick();
    await Promise.resolve();
    tick();
    expect(reads).toBe(2);
    resolveSlowSample();
    const snapshot = await tracker.stop();

    expect(configuredIntervalMs).toBe(1000);
    expect(reads).toBe(3);
    expect(snapshot.map((entry) => entry.pid).sort()).toEqual([100, 101]);
  });

  it('writeTaskEvidence creates non-overwriting timestamped artifacts with sanitized logs', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-evidence-'));
    const input = {
      rootDir,
      taskId: 'task-1',
      runLabel: 'packaged',
      timestamp: '2026-07-11T19-00-00-000Z',
      status: 'FAIL',
      commands: [{ command: 'node scripts/test/e2e-packaged.cjs', exitCode: 1 }],
      assertions: [{ name: 'missing control', ok: false }],
      logs: ['Password: top-secret', 'GET /?password=url-secret', 'Authorization: Bearer bearer-secret'],
    };

    const first = await evidence.writeTaskEvidence(input);
    const second = await evidence.writeTaskEvidence(input);
    const firstText = fs.readFileSync(first.reportPath, 'utf8') + fs.readFileSync(first.jsonPath, 'utf8');

    expect(first.runDir).not.toBe(second.runDir);
    expect(firstText).not.toContain('top-secret');
    expect(firstText).not.toContain('url-secret');
    expect(firstText).not.toContain('bearer-secret');
    expect(firstText).toContain('[redacted]');
  });

  it('allocates collision-free report and screenshot layouts with relative SHA-256 evidence paths', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-unique-layout-'));
    const evidenceRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-runs');
    const screenshotRoot = path.join(projectRoot, '.omo', 'evidence', 'task-1-screenshots');
    const requestedId = 'repeat-run-id';
    const firstLayout = evidence.createTaskRunLayout({
      evidenceRoot,
      screenshotRoot,
      taskId: 'task-1',
      runLabel: 'renderer',
      requestedId,
    });
    const firstScreenshot = path.join(firstLayout.screenshotDir, 'chat.png');
    fs.writeFileSync(firstScreenshot, Buffer.from('first-image'));
    const firstHash = crypto.createHash('sha256').update(fs.readFileSync(firstScreenshot)).digest('hex');
    const first = await evidence.writeTaskEvidence({
      runDir: firstLayout.runDir,
      pathRoot: projectRoot,
      taskId: 'task-1',
      runLabel: 'renderer',
      timestamp: requestedId,
      status: 'PASS',
      screenshots: [{ name: 'chat', path: firstScreenshot, sha256: firstHash }],
    });

    const secondLayout = evidence.createTaskRunLayout({
      evidenceRoot,
      screenshotRoot,
      taskId: 'task-1',
      runLabel: 'renderer',
      requestedId,
    });
    const secondScreenshot = path.join(secondLayout.screenshotDir, 'chat.png');
    fs.writeFileSync(secondScreenshot, Buffer.from('second-image'));
    await evidence.writeTaskEvidence({
      runDir: secondLayout.runDir,
      pathRoot: projectRoot,
      taskId: 'task-1',
      runLabel: 'renderer',
      timestamp: requestedId,
      status: 'PASS',
      screenshots: [{ name: 'chat', path: secondScreenshot }],
    });

    const firstData = JSON.parse(fs.readFileSync(first.jsonPath, 'utf8'));
    expect(secondLayout.runDir).not.toBe(firstLayout.runDir);
    expect(secondLayout.screenshotDir).not.toBe(firstLayout.screenshotDir);
    expect(crypto.createHash('sha256').update(fs.readFileSync(firstScreenshot)).digest('hex')).toBe(firstHash);
    expect(path.isAbsolute(firstData.screenshots[0].path)).toBe(false);
    expect(firstData.screenshots[0]).toMatchObject({ sha256: firstHash });
    expect(firstData.screenshots[0].path).toMatch(/task-1-screenshots\/task-1-renderer-repeat-run-id\/chat\.png$/);
  });

  it('strips ANSI controls and recursively redacts password, token, auth, cookie, and serve secrets', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-ansi-evidence-'));
    const secrets = [
      'ansi-password-secret',
      'ansi-token-secret',
      'ansi-header-secret',
      'ansi-cookie-secret',
      'ansi-serve-secret',
      'nested-object-secret',
    ];
    const written = await evidence.writeTaskEvidence({
      rootDir,
      taskId: 'task-1',
      runLabel: 'redaction',
      timestamp: '2026-07-11T20-00-01-000Z',
      status: 'FAIL',
      context: {
        password: secrets[0],
        nested: { accessToken: secrets[5] },
      },
      assertions: [
        {
          name: 'safe failure',
          ok: false,
          detail: `Authorization: Bearer \u001b[31m${secrets[2]}\u001b[0m`,
        },
      ],
      logs: [
        `Password    \u001b[31mansi-password\u001b[0m-secret`,
        `token=\u001b[32m${secrets[1]}\u001b[0m`,
        `Authorization: Bearer \u001b[33m${secrets[2]}\u001b[0m`,
        `Cookie: session=\u001b[34m${secrets[3]}\u001b[0m`,
        `Web UI http://127.0.0.1:1234/?password=\u001b[35m${secrets[4]}\u001b[0m`,
        `serve-password=\u001b[36m${secrets[4]}\u001b[0m`,
      ],
    });
    const combined = fs.readFileSync(written.reportPath, 'utf8') + fs.readFileSync(written.jsonPath, 'utf8');

    for (const secret of secrets) expect(combined).not.toContain(secret);
    expect(combined).not.toContain('\u001b');
    expect(combined).toContain('[redacted]');
    expect(evidence.scanEvidenceSecrets({ roots: [rootDir] }).count).toBe(0);
  });

  it('removes OSC, CSI, DCS, PM, APC, BEL, NUL, backspace, and C1 controls before secret scanning', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-control-evidence-'));
    const secret = 'split-secret-value';
    const written = await evidence.writeTaskEvidence({
      rootDir,
      taskId: 'task-1',
      runLabel: 'controls',
      timestamp: '2026-07-11T20-00-04-000Z',
      status: 'FAIL',
      logs: [
        `OSC8 \u001b]8;;https://example.test\u0007label\u001b]8;;\u001b\\ end`,
        `OSC52 \u001b]52;c;${Buffer.from('clipboard-secret').toString('base64')}\u001b\\ end`,
        'CSI \u001b[31mred\u001b[0m end',
        'DCS \u001bPprivate-payload\u001b\\ end',
        'PM \u001b^private-message\u001b\\ end',
        'APC \u001b_private-command\u001b\\ end',
        `Password: split\u0008-secret-value`,
        'controls\u0000\u0007\u0085done',
      ],
    });
    const combined = fs.readFileSync(written.reportPath, 'utf8') + fs.readFileSync(written.jsonPath, 'utf8');

    expect(combined).not.toContain('clipboard-secret');
    expect(combined).not.toContain('private-payload');
    expect(combined).not.toContain(secret);
    // 故意断言序列化输出不含控制字符（日志/证据落盘必须可安全渲染）。
    // eslint-disable-next-line no-control-regex
    expect(combined).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(evidence.scanEvidenceSecrets({ roots: [rootDir] })).toMatchObject({ count: 0, paths: [] });
  });

  it('redacts user home, project root, and runtime paths from text evidence', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-path-redaction-'));
    const userHome = os.homedir();
    const projectRoot = path.join(userHome, 'Documents', 'CodeBuddyGUI');
    const runtimeRoot = path.join(projectRoot, '.omo', 'e2e-runtime', 'run-1');
    const written = await evidence.writeTaskEvidence({
      rootDir,
      taskId: 'task-1',
      runLabel: 'paths',
      timestamp: '2026-07-11T20-00-05-000Z',
      status: 'FAIL',
      redactionMap: {
        [runtimeRoot]: '[runtime-root]',
        [projectRoot]: '[project-root]',
      },
      context: { home: userHome, projectRoot, runtimeRoot },
      logs: [`home=${userHome}`, `project=${projectRoot}`, `runtime=${runtimeRoot}`],
    });
    const combined = fs.readFileSync(written.reportPath, 'utf8') + fs.readFileSync(written.jsonPath, 'utf8');

    expect(combined.toLowerCase()).not.toContain(userHome.toLowerCase());
    expect(combined).toContain('[user-home]');
    expect(combined).toContain('[project-root]');
    expect(combined).toContain('[runtime-root]');
  });

  it('sanitizes legacy evidence in place without reporting secret values', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-legacy-evidence-'));
    const reportPath = path.join(rootDir, 'report.md');
    const jsonPath = path.join(rootDir, 'evidence.json');
    fs.writeFileSync(reportPath, 'Password: \u001b[31mlegacy-secret\u001b[0m\n', 'utf8');
    fs.writeFileSync(jsonPath, JSON.stringify({ token: 'legacy-json-secret' }), 'utf8');

    const result = await evidence.sanitizeEvidenceTree({ rootDir });
    const scan = evidence.scanEvidenceSecrets({ roots: [rootDir] });
    const combined = fs.readFileSync(reportPath, 'utf8') + fs.readFileSync(jsonPath, 'utf8');

    expect(result.filesSanitized).toBe(2);
    expect(scan).toMatchObject({ count: 0, paths: [] });
    expect(combined).not.toContain('legacy-secret');
    expect(combined).not.toContain('legacy-json-secret');
  });

  it.runIf(process.platform === 'win32')(
    'rejects a runtime root junction before creating any owned runtime files',
    () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-root-junction-'));
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-root-outside-'));
      const outsideSentinel = path.join(outsideRoot, 'outside-sentinel.txt');
      const runtimeRoot = path.join(projectRoot, '.omo', 'e2e-runtime');
      fs.writeFileSync(outsideSentinel, 'must survive', 'utf8');
      fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
      fs.symlinkSync(outsideRoot, runtimeRoot, 'junction');

      expect(() =>
        driver.createRuntimeLayout({ projectRoot, runStamp: 'junction', label: 'launch' }),
      ).toThrow(/reparse|junction|canonical/i);
      expect(fs.existsSync(outsideSentinel), 'outside sentinel must survive rejected runtime creation').toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'accepts the project root itself through a junction while anchoring descendants to its real path',
    async () => {
      const realProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-real-project-'));
      const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-project-link-'));
      const linkedProjectRoot = path.join(linkParent, 'project');
      fs.symlinkSync(realProjectRoot, linkedProjectRoot, 'junction');

      const layout = driver.createRuntimeLayout({
        projectRoot: linkedProjectRoot,
        runStamp: 'linked-project',
        label: 'launch',
      });

      expect(path.resolve(layout.projectRoot)).toBe(path.resolve(linkedProjectRoot));
      // realProjectRoot 需走与 driver 相同的 canonical 化（realpathSync.native）：
      // CI runner 的 %TEMP% 含 8.3 短路径（RUNNER~1），driver 会展开为长路径。
      const canonicalRealProjectRoot = (fs.realpathSync.native || fs.realpathSync)(realProjectRoot);
      expect(path.resolve(layout.projectRealRoot).toLowerCase()).toBe(
        path.resolve(canonicalRealProjectRoot).toLowerCase(),
      );
      await driver.cleanupRuntimeDir(layout);
      expect(fs.existsSync(layout.runtimeDir)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a reparse descendant inside an otherwise owned runtime before recursive cleanup',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-subtree-junction-'));
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-subtree-outside-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'subtree', label: 'launch' });
      const outsideSentinel = path.join(outsideRoot, 'outside-sentinel.txt');
      fs.writeFileSync(outsideSentinel, 'must survive', 'utf8');
      fs.symlinkSync(outsideRoot, path.join(layout.runtimeDir, 'redirected-user-data'), 'junction');

      await expect(driver.cleanupRuntimeDir(layout)).rejects.toThrow(/reparse|junction/i);
      expect(fs.existsSync(outsideSentinel), 'outside subtree sentinel must survive rejected cleanup').toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects cleanup after a validated runtime ancestor is swapped to an outside junction',
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-swap-'));
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-swap-outside-'));
      const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'swap', label: 'renderer' });
      fs.mkdirSync(layout.userDataDir, { recursive: true });
      const runRoot = path.dirname(layout.runtimeDir);
      const originalRunRoot = `${runRoot}-original`;
      const redirectedRuntimeDir = path.join(outsideRoot, path.basename(layout.runtimeDir));
      const outsideSentinel = path.join(redirectedRuntimeDir, 'outside-sentinel.txt');
      fs.mkdirSync(redirectedRuntimeDir, { recursive: true });
      fs.writeFileSync(outsideSentinel, 'must survive', 'utf8');
      fs.renameSync(runRoot, originalRunRoot);
      fs.symlinkSync(outsideRoot, runRoot, 'junction');

      let cleanupError = null;
      try {
        await driver.cleanupRuntimeDir(layout);
      } catch (error) {
        cleanupError = error;
      }

      expect({
        rejected: cleanupError instanceof Error && /reparse|junction|canonical|ownership/i.test(cleanupError.message),
        outsideSentinelSurvived: fs.existsSync(outsideSentinel),
      }).toEqual({ rejected: true, outsideSentinelSurvived: true });
    },
  );

  it('creates a regular ownership marker whose token is retained in runtime metadata', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-marker-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'marker', label: 'renderer' });

    expect(layout.markerToken).toMatch(/^[0-9a-f]{32}$/);
    expect(layout.markerPath).toBe(path.join(layout.runtimeDir, '.codebuddy-e2e-runtime-owner'));
    expect(fs.lstatSync(layout.markerPath).isFile()).toBe(true);
    expect(fs.readFileSync(layout.markerPath, 'utf8')).toBe(`${layout.markerToken}\n`);
  });

  it('revalidates runtime ownership across Node, PowerShell, and C# controller writes', () => {
    const driverSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-driver.cjs'), 'utf8');
    const powerShellSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.ps1'),
      'utf8',
    );
    const csharpSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'test', 'e2e-job-supervisor.cs'),
      'utf8',
    );

    for (const field of ['ProjectRoot', 'ProjectRealRoot', 'MarkerPath', 'MarkerToken']) {
      expect(driverSource).toContain(`'-${field}'`);
      expect(powerShellSource).toContain(`[string]$${field}`);
    }
    expect(powerShellSource).toContain('Assert-RuntimeOwnership');
    expect(csharpSource).toContain('ValidateRuntimeOwnership();');
    expect(csharpSource).toContain('CanonicalDirectoryPath(projectRoot)');
  });

  it('retries transient Windows quarantine rename failures before removing an owned runtime', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-rename-retry-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'rename-retry', label: 'renderer' });
    fs.mkdirSync(layout.userDataDir, { recursive: true });
    const retryDelays = [];
    let renameAttempts = 0;

    const cleanup = await driver.cleanupRuntimeDir({
      ...layout,
      renameRetries: 3,
      renameRetryDelayMs: 7,
      waitImpl: async (delayMs) => retryDelays.push(delayMs),
      renameImpl(source, destination) {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          const error = new Error('runtime profile is still releasing file handles');
          error.code = 'EPERM';
          throw error;
        }
        fs.renameSync(source, destination);
      },
    });

    expect(renameAttempts).toBe(3);
    expect(retryDelays).toEqual([7, 7]);
    expect(cleanup.removed).toBe(true);
    expect(fs.existsSync(layout.runtimeDir)).toBe(false);
  });
  it('keeps raw Electron profiles outside evidence and safely removes only the owned runtime directory', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-runtime-layout-'));
    const layout = driver.createRuntimeLayout({ projectRoot, runStamp: 'run-1', label: 'renderer' });
    fs.mkdirSync(layout.userDataDir, { recursive: true });
    fs.writeFileSync(path.join(layout.userDataDir, 'codebuddy-password.txt'), 'secret', 'utf8');

    expect(layout.runtimeDir).toContain(path.join('.omo', 'e2e-runtime'));
    expect(layout.runtimeDir).not.toContain(path.join('.omo', 'evidence'));
    await driver.cleanupRuntimeDir(layout);
    expect(fs.existsSync(layout.runtimeDir)).toBe(false);

    await expect(
      driver.cleanupRuntimeDir({
        runtimeRoot: path.join(projectRoot, '.omo', 'e2e-runtime'),
        runtimeDir: projectRoot,
      }),
    ).rejects.toThrow('outside the owned runtime root');
  });

  it('seeds a disposable product state before waiting for an active project runtime', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-product-state-fixture-'));
    const userDataDir = path.join(projectRoot, 'user-data');

    const seeded = driver.seedProductState({ userDataDir, projectRoot });
    const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'product-state.json'), 'utf8'));

    expect(seeded.activeProjectId).toBe('project-e2e');
    expect(seeded.activeThreadId).toBe('thread-e2e');
    expect(stored.projectsById['project-e2e']).toMatchObject({
      id: 'project-e2e',
      workspacePath: path.resolve(projectRoot),
    });
    expect(stored.threadsById['thread-e2e']).toMatchObject({
      id: 'thread-e2e',
      projectId: 'project-e2e',
      sessionId: null,
    });

    for (const relativePath of [
      'scripts/test/e2e-launch.cjs',
      'scripts/test/e2e-renderer.cjs',
      'scripts/test/e2e-packaged.cjs',
    ]) {
      expect(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8'), relativePath).toContain('seedProductState');
    }
  });

  it('asserts the current project entrypoint instead of a removed workspace-switch button', () => {
    const launchScript = fs.readFileSync(path.join(process.cwd(), 'scripts/test/e2e-launch.cjs'), 'utf8');
    expect(launchScript).toContain("name: '展开桌面扩展'");
    expect(launchScript).toContain("name: '实例列表'");
    expect(launchScript).toContain("name: '添加项目'");
    expect(launchScript).not.toContain("name: '切换工作区目录'");

    const packagedScript = fs.readFileSync(path.join(process.cwd(), 'scripts/test/e2e-packaged.cjs'), 'utf8');
    expect(packagedScript).toContain('driveRoutes(client');
    expect(packagedScript).toContain('ROUTE_EXPECTATIONS');
    expect(packagedScript).not.toContain("name: '添加项目'");
    expect(packagedScript).not.toContain("name: '切换工作区目录'");
  });

  it('uses strict disposable Electron profiles and documents persistent dedicated-runner backend state', () => {
    for (const relativePath of [
      'scripts/test/e2e-launch.cjs',
      'scripts/test/e2e-renderer.cjs',
      'scripts/test/e2e-packaged.cjs',
    ]) {
      const script = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      expect(script, relativePath).toContain('createRuntimeLayout');
      expect(script, relativePath).toContain('cleanupRuntimeDir');
      expect(script, relativePath).toContain('requireUsableCodeBuddyStartup');
      expect(script, relativePath).toContain('sanitizeText(error.stack || error.message || error)');
      expect(script, relativePath).toContain('strictUserDataOnly: true');
      expect(script, relativePath).toContain('dedicated authenticated test profile');
      expect(script, relativePath).toContain('backend session state may persist');
      expect(script, relativePath).toContain('createOverallWatchdog');
      expect(script, relativePath).toContain('createSingleFinalizer');
      expect(script, relativePath).toContain('throwIfAborted');
      expect(script, relativePath).toContain('async function main(signal)');
      expect(script, relativePath).toContain('signal,');
      expect(script, relativePath).toContain('finalizeHarnessRun');
      expect(script, relativePath).not.toContain('if (error?.finalizationSafe === false)');
      expect(script, relativePath).toContain('createTaskRunLayout');
      expect(script, relativePath).toContain('pathRoot: projectRoot');
      expect(script, relativePath).toContain('processTracker.stop()');
      expect(script, relativePath).toContain('trackedProcesses');
      expect(script, relativePath).not.toMatch(/\.then\(\(\) => finish\(\)\)\s*\.catch\(/);
      expect(script, relativePath).not.toContain("'task-1-runtime'");
      expect(script, relativePath).not.toMatch(/startupLog:\s*startup\?\.path/);
    }
  });

  it('all desktop harnesses dispatch exactly one finalizer, emit stderr-safe failures, and hard-exit only afterward', () => {
    for (const relativePath of [
      'scripts/test/e2e-launch.cjs',
      'scripts/test/e2e-renderer.cjs',
      'scripts/test/e2e-packaged.cjs',
    ]) {
      const script = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      const callbackIndex = script.indexOf('onOwnershipController(controller)');
      const dispatcherIndex = script.indexOf('const finalization = await finalizeHarnessRun({');
      const emergencyIndex = script.indexOf('unsafeFinalizer: () => finalizeUnsafeHarnessFailure({', dispatcherIndex);
      const hardExitIndex = script.indexOf('setTimeout(() => process.exit(1), 1000)', dispatcherIndex);

      expect(script, relativePath).toContain('createOwnershipCleanupEvidence');
      expect(script, relativePath).toContain('finalizeHarnessRun');
      expect(script, relativePath).toContain('finalizeUnsafeHarnessFailure');
      expect(script, relativePath).toContain('let ownershipController = null');
      expect(callbackIndex, `${relativePath} must publish the controller during launch`).toBeGreaterThan(-1);
      expect(dispatcherIndex, `${relativePath} must use the shared finalization dispatcher`).toBeGreaterThan(-1);
      expect(emergencyIndex, `${relativePath} must write bounded unsafe-finalization evidence`).toBeGreaterThan(-1);
      expect(hardExitIndex, `${relativePath} must finish emergency evidence before scheduling process exit`).toBeGreaterThan(
        dispatcherIndex,
      );
      const dispatchBlock = script.slice(dispatcherIndex, hardExitIndex);
      expect(dispatchBlock, relativePath).toContain('normalFinalizer: finalize');
      expect(dispatchBlock, relativePath).toContain('writeEvidence: writeTaskEvidence');
      expect(dispatchBlock, relativePath).toContain('runDir: runLayout.runDir');
      expect(dispatchBlock, relativePath).toContain('for (const stderrFailure of finalization.result?.stderrFailures || [])');
      expect(script.match(/await finalizeHarnessRun\(\{/g) || [], relativePath).toHaveLength(1);
      expect(script, relativePath).not.toContain('if (error?.finalizationSafe === false)');
      expect(script, relativePath).not.toContain('await finalize(error)');
      expect(script, relativePath).toContain('launchCleanupErrors');
      expect(script, relativePath).toContain('ownershipBoundary');
      expect(script, relativePath).toContain('remainingVerifiedProcesses');
      expect(script, relativePath).toMatch(/cleanup:\s*cleanupEvidence/);
    }
  });

  it('waits for a visibly replaced session ID before the renderer sends any chat round', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-renderer.cjs'), 'utf8');
    const initialReady = script.indexOf('const initialSessionId = await waitForVisibleSettingValue');
    const newChat = script.indexOf("name: '新对话'", initialReady);
    const replacementReady = script.indexOf('value !== initialSessionId', newChat);
    const firstChat = script.indexOf('await sendChatRound(round, signal)', replacementReady);

    expect(initialReady).toBeGreaterThan(-1);
    expect(newChat).toBeGreaterThan(initialReady);
    expect(replacementReady).toBeGreaterThan(newChat);
    expect(firstChat).toBeGreaterThan(replacementReady);
  });

  it('records the Stop probe as UI-only evidence without claiming backend cancellation success', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-renderer.cjs'), 'utf8');
    const cancelBlocker = baseline.BASELINE_INVENTORY.find(
      (entry) => entry.id === 'backend-cancel-semantic-noop',
    );

    expect(script).toContain('visible stop control was invoked and UI left streaming state');
    expect(script).toContain('visible stop control received a deterministic invoke');
    expect(script).toContain("stopDispatch.action === 'invoke'");
    expect(script).toContain('backend cancellation semantics NOT verified / baseline-open');
    expect(script).not.toContain("action: 'click'");
    expect(script).not.toMatch(/cancels? the active response|cancelled active response/i);
    expect(script).not.toMatch(/backend (?:stopped|cancelled)|no (?:later|post-cancel) activity/i);
    expect(cancelBlocker).toMatchObject({
      disposition: 'OPEN_BASELINE_BLOCKER',
      owningTask: expect.stringContaining('Task 5'),
    });
  });

  it('validates CODEBUDDY_E2E_CHAT_ROUNDS instead of coercing invalid coverage to zero iterations', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'test', 'e2e-renderer.cjs'), 'utf8');
    expect(script).toContain('parsePositiveInteger');
    expect(script).toContain("name: 'CODEBUDDY_E2E_CHAT_ROUNDS'");
    expect(script).not.toContain('Number(process.env.CODEBUDDY_E2E_CHAT_ROUNDS || 10)');
  });

  it('findStartupLog locates the packaged app.getPath(userData) log instead of assuming the project root', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-log-'));
    const projectRoot = path.join(tempDir, 'repo');
    const appDataDir = path.join(tempDir, 'AppData', 'Roaming');
    const userDataDir = path.join(appDataDir, 'codebuddy-gui');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    const expected = path.join(userDataDir, 'electron-startup.log');
    fs.writeFileSync(expected, 'renderer ready=true\n', 'utf8');

    const found = driver.findStartupLog({
      projectRoot,
      appDataDir,
      appName: 'codebuddy-gui',
      packaged: true,
    });

    expect(found.path).toBe(expected);
    expect(found.source).toBe('userData');
    expect(found.text).toContain('renderer ready=true');
  });

  it('strict startup-log lookup ignores stale global and project-root logs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-e2e-strict-log-'));
    const projectRoot = path.join(tempDir, 'repo');
    const appDataDir = path.join(tempDir, 'AppData', 'Roaming');
    const userDataDir = path.join(tempDir, 'current-user-data');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(appDataDir, 'codebuddy-gui'), { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'electron-startup.log'), 'stale project log', 'utf8');
    fs.writeFileSync(path.join(appDataDir, 'codebuddy-gui', 'electron-startup.log'), 'stale global log', 'utf8');

    const found = driver.findStartupLog({
      projectRoot,
      appDataDir,
      appName: 'codebuddy-gui',
      userDataDir,
      strictUserDataOnly: true,
    });

    expect(found).toMatchObject({ path: null, source: null, text: '' });
    expect(found.candidates).toEqual([path.join(userDataDir, 'electron-startup.log')]);
  });

  it('defines route coverage as route-specific visible controls rather than generic text length', () => {
    expect(driver.ROUTE_EXPECTATIONS).toHaveLength(20);
    for (const route of driver.ROUTE_EXPECTATIONS) {
      expect(route).toMatchObject({
        route: expect.any(String),
        navLabel: expect.any(String),
        expected: { role: expect.any(String), name: expect.any(String) },
      });
      expect(route.expected.name.length).toBeGreaterThan(0);
      expect(route).not.toHaveProperty('minTextLength');
    }
    expect(new Set(driver.ROUTE_EXPECTATIONS.map((route) => route.route))).toEqual(new Set([
      'chat', 'instances', 'remote-control', 'tasks', 'archived', 'terminal', 'editor', 'changes',
      'plugins', 'skills', 'agents', 'mcp', 'sandboxes', 'stats', 'traces', 'metrics', 'logs', 'workers',
      'settings', 'keybindings',
    ]));
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'models')).toBeUndefined();
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'monitor')).toBeUndefined();
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'instances')).toMatchObject({
      navLabel: '实例列表',
      navGroup: '桌面扩展',
      expected: { role: 'button', name: '添加项目' },
    });
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'metrics')).toMatchObject({
      navLabel: '监控',
      navGroup: '可观测',
    });
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'workers')).toMatchObject({
      navLabel: 'Agent 实例管理',
      navGroup: '桌面扩展',
      expected: { role: 'textbox', name: '搜索 Worker、目录、Endpoint 或主机...' },
    });
    expect(driver.ROUTE_EXPECTATIONS.find((route) => route.route === 'keybindings')?.expected).toEqual({
      role: 'textbox', name: '搜索快捷键、动作或上下文...',
    });
    for (const relativePath of [
      'scripts/test/e2e-renderer.cjs',
      'scripts/test/e2e-packaged.cjs',
    ]) {
      const script = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      // Route counts must be derived from ROUTE_EXPECTATIONS.length rather than
      // hardcoded, so adding/removing a route never silently desyncs the check.
      expect(script, relativePath).toContain('routeResults.length === ROUTE_EXPECTATIONS.length');
      expect(script, relativePath).toContain('contactSheet.screenshots === routeScreenshots.length');
      expect(script, relativePath).toContain("result.route === 'chat' && !result.state.hash");
      // No hardcoded route-count magic numbers should remain.
      expect(script, relativePath).not.toContain('routeResults.length === 21');
      expect(script, relativePath).not.toContain('routeResults.length === 19');
      expect(script, relativePath).not.toContain('contactSheet.screenshots === 19');
    }
  });

  it('never image-name-kills a desktop instance and always passes the tracked root identity to cleanupOwned', () => {
    // `taskkill /F /IM "CodeBuddy Desktop.exe"` hits a user's real installation
    // and was explicitly called out as a security blocker in the baseline list;
    // every cleanup must stay within the owned process tree instead.
    const scripts = [
      'scripts/test/verify-user-messages.cjs',
      'scripts/test/verify-unpacked-clean.cjs',
      'scripts/test/manual-goal-gui.cjs',
      'scripts/test/manual-output-prod-gui.cjs',
      'scripts/test/manual-plugins-gui.cjs',
      'scripts/test/manual-transport-reconnect-gui.cjs',
    ];
    for (const relativePath of scripts) {
      const script = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      // The execution form must be gone (documentation may mention the hazard).
      expect(script, relativePath).not.toMatch(/spawnSync\(['"]taskkill/);
      expect(script, relativePath).not.toMatch(/['"]\/IM['"]/);
      // cleanupOwned(launched) left trackedProcesses empty (nothing was ever
      // killed); the owned-tree form must carry the root identity.
      expect(script, relativePath).toContain('trackedProcesses: launched.rootIdentity ? [launched.rootIdentity] : []');
    }
  });
});
