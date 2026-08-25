import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiBase } from '../../src/lib/acp';
import { PtySocket, ptySendInputHttp, reconnectDelayForAttempt } from '../../src/lib/pty';

describe('PtySocket Electron SSE transport', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:45678');
    window.electronAPI = undefined;
  });

  it('closes the preload stream handle when the GET stream fails', async () => {
    let handlers;
    const close = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })),
      openCodeBuddyStream: vi.fn((_request, nextHandlers) => {
        handlers = nextHandlers;
        return { close };
      }),
    };

    const socket = new PtySocket('pty-1');
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.connect();

    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledOnce());
    handlers.onError(new Error('stream closed'));

    expect(close).toHaveBeenCalledOnce();
    expect(socket._sseStream).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  // P1: the PTY output stream is a resident long-lived connection, exactly like
  // the ACP notification stream in acp.js. Without timeoutMs: 0 the main-process
  // openStream applies its default 30s chunk-idle timeout and kills the stream
  // of any terminal that is simply quiet, silently losing all later output.
  it('opens the SSE output stream with timeoutMs: 0 (no idle kill for quiet terminals)', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })),
      openCodeBuddyStream: vi.fn(() => ({ close: () => {} })),
    };

    const socket = new PtySocket('pty-idle');
    socket.connect();
    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledOnce());

    const request = window.electronAPI.openCodeBuddyStream.mock.calls[0][0];
    expect(request.url).toContain('/api/v1/pty/pty-idle/output');
    expect(request.timeoutMs).toBe(0);
  });

  // M-ls5: a failed SSE connect must reset _transport so a later connect() can
  // retry WS instead of silently POSTing to /input/send on a half-dead session.
  it('resets _transport to null when the SSE connect fails', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' })),
      openCodeBuddyStream: vi.fn(() => ({ close: () => {} })),
    };
    const onError = vi.fn();
    const onClose = vi.fn();
    const socket = new PtySocket('pty-fail');
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.connect();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(socket._transport).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('PtySocket WS reconnect lifecycle (M-ls9)', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:45678');
    window.electronAPI = undefined;
  });

  it('does not reconnect after close() even if a reconnect attempt was scheduled', async () => {
    vi.useFakeTimers();
    // Fake WebSocket: opens immediately, then closes with a non-1000 code to
    // trigger _tryReconnect scheduling.
    let wsInstances = [];
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        wsInstances.push(this);
        // Become OPEN on the next tick.
        queueMicrotask(() => {
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        });
      }
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1006 });
      }
      send() {}
    }
    const originalWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeWS;
    try {
      const socket = new PtySocket('pty-reconnect');
      const onReconnecting = vi.fn();
      socket.on('reconnecting', onReconnecting);
      socket.connect();
      // Let the initial WS open.
      await vi.advanceTimersByTimeAsync(0);
      // Close the WS to schedule a reconnect attempt.
      const firstWs = wsInstances[0];
      firstWs.close();
      await vi.advanceTimersByTimeAsync(0);
      // A reconnect attempt should have been scheduled (reconnecting emitted).
      // Now close the PTY explicitly.
      socket.close();
      // Advance past the reconnect interval — no new WS should be created.
      const wsCountBefore = wsInstances.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(wsInstances.length).toBe(wsCountBefore);
    } finally {
      globalThis.WebSocket = originalWS;
      vi.useRealTimers();
    }
  });

  it('backs off exponentially while the daemon stays unreachable (M-ls14)', async () => {
    vi.useFakeTimers();
    let wsInstances = [];
    // A socket that never opens: the connect-timeout drives consecutive failed
    // attempts. Vitest fake timers fire nested setTimeout early, so exact
    // inter-attempt gaps are asserted on the pure ladder instead; here we only
    // verify that attempts keep escalating and sockets keep being created.
    class NeverOpenWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        wsInstances.push(this);
      }
      close() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1006 });
      }
      send() {}
    }
    const originalWS = globalThis.WebSocket;
    globalThis.WebSocket = NeverOpenWS;
    try {
      const socket = new PtySocket('pty-backoff');
      socket.connect();
      // Initial socket never opens → connect-timeout at 3s schedules the first
      // retry; the first reconnect socket appears shortly after.
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(wsInstances.length).toBeGreaterThanOrEqual(2);

      // Keep the daemon dead: attempts must keep escalating (never reset) and
      // further sockets must appear (retries keep happening).
      const attemptsBefore = socket._reconnectAttempts;
      for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(socket._reconnectAttempts).toBeGreaterThan(attemptsBefore);
      expect(wsInstances.length).toBeGreaterThan(2);
    } finally {
      globalThis.WebSocket = originalWS;
      vi.useRealTimers();
    }
  });

  it('computes the exponential backoff ladder with a 30s cap', () => {
    expect(reconnectDelayForAttempt(1000, 1)).toBe(1000);
    expect(reconnectDelayForAttempt(1000, 2)).toBe(2000);
    expect(reconnectDelayForAttempt(1000, 3)).toBe(4000);
    expect(reconnectDelayForAttempt(1000, 6)).toBe(30000); // 32s → capped
    expect(reconnectDelayForAttempt(1000, 10)).toBe(30000);
  });
});

describe('PTY SSE input reliability (M-ls13)', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:45678');
    window.electronAPI = undefined;
  });

  it('surfaces ptySendInputHttp failures instead of swallowing them', async () => {
    window.electronAPI = {
      requestCodeBuddy: vi.fn(async () => {
        throw new Error('daemon unreachable');
      }),
    };
    await expect(ptySendInputHttp('pty-1', 'echo hi')).rejects.toThrow('daemon unreachable');
  });

  it('serializes SSE input flushes and surfaces failures via the error event', async () => {
    const deferred = [];
    window.electronAPI = {
      requestCodeBuddy: vi.fn((request) => {
        if (String(request?.url || '').includes('/input/send')) {
          return new Promise((resolve, reject) => {
            deferred.push({ resolve, reject });
          });
        }
        // Session availability probe from _connectSse resolves immediately.
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', body: '{}', headers: {} });
      }),
      openCodeBuddyStream: vi.fn(() => ({ close: () => {} })),
    };

    const socket = new PtySocket('pty-serial');
    const onError = vi.fn();
    socket.on('error', onError);
    socket.connect();
    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalled());

    socket.sendInput('a');
    await new Promise((r) => setTimeout(r, 25)); // first 16ms flush fires, POST hangs
    expect(deferred).toHaveLength(1);

    socket.sendInput('b');
    await new Promise((r) => setTimeout(r, 25)); // second flush must wait for the first
    expect(deferred).toHaveLength(1);

    // Release the first POST — only then may the second one start (in order).
    deferred[0].reject(new Error('daemon gone'));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0].message).toBe('daemon gone');

    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    expect(window.electronAPI.requestCodeBuddy).toHaveBeenCalledTimes(3); // 1 probe + 2 input POSTs
  });

  it('treats a server-closed SSE stream as terminal without reconnecting', async () => {
    let handlers;
    const close = vi.fn();
    const requestCodeBuddy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    }));
    window.electronAPI = {
      requestCodeBuddy,
      openCodeBuddyStream: vi.fn((_req, nextHandlers) => {
        handlers = nextHandlers;
        return { close };
      }),
    };

    const socket = new PtySocket('pty-end-ok');
    const onClose = vi.fn();
    socket.on('close', onClose);
    socket.connect();
    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledOnce());

    handlers.onEnd({ ok: true, status: 200 });
    expect(close).toHaveBeenCalledOnce();
    expect(socket._sseStream).toBeNull();
    expect(socket._transport).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    // Normal end must not reconnect.
    expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledTimes(1);
  });

  it('reconnects through connect() when the SSE stream drops abnormally', async () => {
    let handlers;
    const close = vi.fn();
    const requestCodeBuddy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    }));
    window.electronAPI = {
      requestCodeBuddy,
      openCodeBuddyStream: vi.fn((_req, nextHandlers) => {
        handlers = nextHandlers;
        return { close };
      }),
    };

    const socket = new PtySocket('pty-end-bad');
    socket.connect();
    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledOnce());

    handlers.onEnd({ ok: false, status: 502 });
    // A fresh SSE connect is issued (same SSE-first routing), and the reconnect
    // budget is reset on the successful re-open.
    await vi.waitFor(() => expect(window.electronAPI.openCodeBuddyStream).toHaveBeenCalledTimes(2));
    expect(socket._reconnecting).toBe(false);
    expect(socket._reconnectAttempts).toBe(0);
  });
});
