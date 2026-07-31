import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';

describe('store account auth (ACP _codebuddy.ai/authUrl)', () => {
  let openExternal;

  beforeEach(() => {
    openExternal = vi.fn().mockResolvedValue({ url: 'https://example.com/login' });
    window.electronAPI = { openExternal };
    useStore.setState({
      codeBuddyAccountAuthState: 'authenticating',
      codeBuddyAccountAuthUrl: null,
      codeBuddyAccountAuthError: null,
      _accountAuthGeneration: 1,
    });
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('stores the login URL and opens it in the browser while authenticating', () => {
    const handled = useStore
      .getState()
      .handleAccountAuthUrl({ authUrl: 'https://www.codebuddy.cn/oauth/authorize?app=1' });

    expect(handled).toBe(true);
    expect(useStore.getState().codeBuddyAccountAuthUrl).toBe(
      'https://www.codebuddy.cn/oauth/authorize?app=1',
    );
    expect(useStore.getState().codeBuddyAccountAuthError).toBeNull();
    expect(openExternal).toHaveBeenCalledWith('https://www.codebuddy.cn/oauth/authorize?app=1');
  });

  it('keeps the URL visible in the sidebar even when the browser cannot open', () => {
    openExternal.mockRejectedValue(new Error('no default browser'));
    const handled = useStore
      .getState()
      .handleAccountAuthUrl({ authUrl: 'https://copilot.tencent.com/login' });

    expect(handled).toBe(true);
    expect(useStore.getState().codeBuddyAccountAuthUrl).toBe('https://copilot.tencent.com/login');
  });

  it('ignores authUrl events when login is not in progress', () => {
    useStore.setState({ codeBuddyAccountAuthState: 'required' });
    const handled = useStore
      .getState()
      .handleAccountAuthUrl({ authUrl: 'https://www.codebuddy.ai/login' });

    expect(handled).toBe(false);
    expect(useStore.getState().codeBuddyAccountAuthUrl).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('ignores malformed URLs', () => {
    const handled = useStore.getState().handleAccountAuthUrl({ authUrl: 'javascript:alert(1)' });

    expect(handled).toBe(false);
    expect(useStore.getState().codeBuddyAccountAuthUrl).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not re-open the browser for a repeated notification of the same URL', () => {
    const authUrl = 'https://www.codebuddy.cn/oauth/authorize';

    useStore.getState().handleAccountAuthUrl({ authUrl });
    useStore.getState().handleAccountAuthUrl({ authUrl });

    expect(useStore.getState().codeBuddyAccountAuthUrl).toBe(authUrl);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('forwards conversation events of type _codebuddy.ai/authUrl to the handler', () => {
    useStore.setState({
      activeProjectId: 'project-1',
      activeThreadId: 'thread-1',
      projectsById: { 'project-1': { id: 'project-1', workspacePath: 'C:/Project' } },
      threadsById: {
        'thread-1': { id: 'thread-1', projectId: 'project-1', sessionId: 'session-1', metadata: {} },
      },
    });

    useStore.getState().handleConversationEvent({
      threadId: 'thread-1',
      type: '_codebuddy.ai/authUrl',
      detail: { authUrl: 'https://www.codebuddy.cn/oauth/authorize', provider: 'external' },
    });

    expect(useStore.getState().codeBuddyAccountAuthUrl).toBe(
      'https://www.codebuddy.cn/oauth/authorize',
    );
    expect(openExternal).toHaveBeenCalledWith('https://www.codebuddy.cn/oauth/authorize');
  });
});
