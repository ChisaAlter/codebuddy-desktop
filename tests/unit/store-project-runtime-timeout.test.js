import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAcpSessionToken, setAuthToken } from '../../src/lib/acp';
import { useStore } from '../../src/store';

describe('project runtime start timeout', () => {
  beforeEach(() => {
    setAuthToken(null);
    setAcpSessionToken(null);
    vi.useFakeTimers();
    window.electronAPI = {
      ensureProjectRuntime: vi.fn(),
      requestCodeBuddy: vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', body: '' }),
    };
    useStore.setState({
      activeProjectId: 'project-1',
      productStateLoaded: true,
      apiBase: 'http://127.0.0.1:1000',
      projectsById: {
        'project-1': { id: 'project-1', workspacePath: 'C:/Project', runtimeStatus: 'stopped' },
      },
      projectOrder: ['project-1'],
      threadsById: {},
      threadOrderByProject: { 'project-1': [] },
      connectionState: 'disconnected',
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it('leaves the starting state when the start IPC never resolves', async () => {
    window.electronAPI.ensureProjectRuntime.mockReturnValue(new Promise(() => {}));

    const promise = useStore.getState().ensureProjectRuntime('project-1');
    // The runtime operation runs on the project's microtask chain; flush it
    // before asserting the transitional status.
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().projectsById['project-1'].runtimeStatus).toBe('starting');
    await vi.advanceTimersByTimeAsync(60000);
    await promise;

    const project = useStore.getState().projectsById['project-1'];
    expect(project.runtimeStatus).toBe('error');
    expect(project.runtimeError).toMatch(/超时/);
    expect(useStore.getState().connectionState).toBe('error');
  });

  it('still transitions to running when the IPC resolves in time', async () => {
    window.electronAPI.ensureProjectRuntime.mockResolvedValue({
      projectId: 'project-1',
      status: 'running',
      port: 45678,
      password: null,
    });

    const promise = useStore.getState().ensureProjectRuntime('project-1');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(useStore.getState().projectsById['project-1'].runtimeStatus).toBe('running');
    expect(useStore.getState().apiBase).toBe('http://127.0.0.1:45678');
  });
});
