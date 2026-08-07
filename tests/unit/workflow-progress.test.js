import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compressWorkspacePath,
  readLatestWorkflowProgress,
  readProjectWorkflowProgress,
} = require('../../electron/workflow-progress.cjs');

describe('CodeBuddy workflow progress reader', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeFixture({ record, journal = [], cwd = 'C:\\Work\\Demo', sessionId = 'session-1' }) {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-workflow-progress-'));
    tempDirs.push(configRoot);
    const projectDir = path.join(configRoot, 'projects', compressWorkspacePath(cwd), sessionId);
    const runId = record.runId;
    const workflowDir = path.join(projectDir, 'workflows');
    const journalDir = path.join(projectDir, 'subagents', 'workflows', `wf_${runId}`);
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, `wf_${runId}.json`), JSON.stringify(record), 'utf8');
    fs.writeFileSync(
      path.join(journalDir, 'journal.jsonl'),
      journal.map((event) => JSON.stringify(event)).join('\n'),
      'utf8',
    );
    return { configRoot, cwd, sessionId, runId };
  }

  it('compresses a Windows workspace path using the CLI directory convention', () => {
    expect(compressWorkspacePath('C:\\Users\\me\\CodeBuddyGUI')).toBe('C-Users-me-CodeBuddyGUI');
  });

  it('projects a running phase and agent from the record and journal', async () => {
    const fixture = makeFixture({
      record: {
        runId: 'run-live',
        name: 'package-read',
        description: 'Inspect metadata',
        status: 'running',
        startedAt: 2_000,
        phaseCount: 1,
        agentCount: 1,
        phases: [{ title: 'Inspect' }],
      },
      journal: [
        { type: 'run_started', runId: 'run-live', name: 'package-read', startedAt: 2_010 },
        {
          type: 'agent_started',
          runId: 'run-live',
          key: 'agent-key',
          label: 'package-reader',
          phase: 'Inspect',
          startedAt: 2_020,
        },
      ],
    });

    await expect(readLatestWorkflowProgress({ ...fixture, startedAfter: 1_500 })).resolves.toMatchObject({
      runId: 'run-live',
      name: 'package-read',
      description: 'Inspect metadata',
      status: 'running',
      active: true,
      phase: 'Inspect',
      phaseCount: 1,
      agentCount: 1,
      agents: [
        {
          id: 'agent-key',
          name: 'package-reader',
          phase: 'Inspect',
          status: 'running',
          startedAt: 2_020,
        },
      ],
    });
  });

  it('projects agent and workflow completion from terminal journal events', async () => {
    const fixture = makeFixture({
      record: {
        runId: 'run-done',
        name: 'package-read',
        status: 'completed',
        startedAt: 3_000,
        endedAt: 3_500,
        phaseCount: 1,
        agentCount: 1,
      },
      journal: [
        {
          type: 'agent_started',
          runId: 'run-done',
          key: 'agent-key',
          label: 'package-reader',
          phase: 'Inspect',
          startedAt: 3_010,
        },
        {
          type: 'agent_finished',
          runId: 'run-done',
          key: 'agent-key',
          sessionId: 'agent-session',
          tokens: 54_671,
          endedAt: 3_490,
        },
        { type: 'run_finished', runId: 'run-done', status: 'completed', endedAt: 3_500 },
      ],
    });

    await expect(readLatestWorkflowProgress({ ...fixture, startedAfter: 2_500 })).resolves.toMatchObject({
      status: 'completed',
      active: false,
      completedAt: 3_500,
      agents: [
        {
          id: 'agent-key',
          name: 'package-reader',
          status: 'completed',
          tokens: 54_671,
          completedAt: 3_490,
        },
      ],
    });
  });

  it('ignores workflows older than the prompt and rejects unsafe identifiers', async () => {
    const fixture = makeFixture({
      record: { runId: 'run-old', name: 'old', status: 'completed', startedAt: 1_000, endedAt: 1_100 },
    });

    await expect(readLatestWorkflowProgress({ ...fixture, runId: null, startedAfter: 1_500 })).resolves.toBeNull();
    await expect(
      readLatestWorkflowProgress({ ...fixture, sessionId: '../other', startedAfter: 0 }),
    ).resolves.toBeNull();
    await expect(
      readLatestWorkflowProgress({ ...fixture, runId: '../other', startedAfter: 0 }),
    ).resolves.toBeNull();
  });

  it('returns null instead of throwing while a workflow record is partially written', async () => {
    const fixture = makeFixture({
      record: { runId: 'run-partial', name: 'partial', status: 'running', startedAt: 4_000 },
    });
    const recordPath = path.join(
      fixture.configRoot,
      'projects',
      compressWorkspacePath(fixture.cwd),
      fixture.sessionId,
      'workflows',
      `wf_${fixture.runId}.json`,
    );
    fs.writeFileSync(recordPath, '{"runId":"run-partial"', 'utf8');

    await expect(readLatestWorkflowProgress({ ...fixture, startedAfter: 3_000 })).resolves.toBeNull();
  });

  it('resolves cwd from the trusted project runtime and ignores a renderer cwd', async () => {
    const fixture = makeFixture({
      record: { runId: 'run-trusted', name: 'trusted', status: 'running', startedAt: 5_000 },
    });
    const runtimeManager = {
      list: () => [{ projectId: 'project-1', cwd: fixture.cwd, status: 'running' }],
    };

    expect(readProjectWorkflowProgress).toEqual(expect.any(Function));
    await expect(
      readProjectWorkflowProgress({
        runtimeManager,
        configRoot: fixture.configRoot,
        request: {
          projectId: 'project-1',
          sessionId: fixture.sessionId,
          runId: fixture.runId,
          startedAfter: 4_500,
          cwd: 'C:\\Other\\Secret',
        },
      }),
    ).resolves.toMatchObject({ runId: 'run-trusted', name: 'trusted' });
    await expect(
      readProjectWorkflowProgress({
        runtimeManager,
        configRoot: fixture.configRoot,
        request: { projectId: 'project-other', sessionId: fixture.sessionId, startedAfter: 0 },
      }),
    ).resolves.toBeNull();
  });
});
