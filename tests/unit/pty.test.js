import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiBase } from '../../src/lib/acp';
import { PtySocket } from '../../src/lib/pty';

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
});
