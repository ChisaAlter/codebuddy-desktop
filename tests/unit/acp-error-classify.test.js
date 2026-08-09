import { describe, expect, it, vi } from 'vitest';
import { AcpClient, classifyTransportFailure, normalizeStreamError, setApiBase } from '../../src/lib/acp';

function makeClient() {
  const client = new AcpClient();
  client.connected = true;
  client.connectionId = 'conn-1';
  client.requestHttp = vi.fn();
  client.markConnectionBroken = vi.fn();
  return client;
}

function okResponse(textValue) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    text: async () => textValue,
  };
}

describe('classifyTransportFailure', () => {
  it('401 → auth', () => {
    expect(classifyTransportFailure({ status: 401, kind: 'http' })).toBe('auth');
  });

  it('429 → rate_limit', () => {
    expect(classifyTransportFailure({ status: 429, kind: 'http' })).toBe('rate_limit');
  });

  it('4xx (non-401/429) → client', () => {
    expect(classifyTransportFailure({ status: 400, kind: 'http' })).toBe('client');
    expect(classifyTransportFailure({ status: 403, kind: 'http' })).toBe('client');
    expect(classifyTransportFailure({ status: 404, kind: 'http' })).toBe('client');
  });

  it('5xx → upstream (not transport)', () => {
    expect(classifyTransportFailure({ status: 502, kind: 'http' })).toBe('upstream');
    expect(classifyTransportFailure({ status: 503, kind: 'http' })).toBe('upstream');
    expect(classifyTransportFailure({ status: 504, kind: 'http' })).toBe('upstream');
  });

  it('status null + network/timeout → transport', () => {
    expect(classifyTransportFailure({ status: null, kind: 'network' })).toBe('transport');
    expect(classifyTransportFailure({ status: null, kind: 'timeout' })).toBe('transport');
  });

  it('status null + idle-timeout → idle (main-process stream idle)', () => {
    expect(classifyTransportFailure({ status: null, kind: 'idle-timeout' })).toBe('idle');
  });

  it('status null + parse/closed → client', () => {
    expect(classifyTransportFailure({ status: null, kind: 'parse' })).toBe('client');
    expect(classifyTransportFailure({ status: null, kind: 'closed' })).toBe('client');
  });

  it('status null + unknown kind → transport (conservative)', () => {
    expect(classifyTransportFailure({ status: null, kind: null })).toBe('transport');
  });

  it('long-running idle timeout → idle', () => {
    expect(
      classifyTransportFailure({ status: null, kind: null, isLongRunningIdleTimeout: true }),
    ).toBe('idle');
  });

  it('RPC business error → rpc', () => {
    expect(classifyTransportFailure({ status: null, kind: null, isRpcError: true })).toBe('rpc');
  });
});

describe('normalizeStreamError', () => {
  it('accepts string', () => {
    expect(normalizeStreamError('boom')).toEqual({ message: 'boom', status: null, kind: null });
  });

  it('accepts {message,status,kind} object', () => {
    expect(normalizeStreamError({ message: 'm', status: 401, kind: 'http' })).toEqual({
      message: 'm',
      status: 401,
      kind: 'http',
    });
  });

  it('accepts Error with status/kind attached', () => {
    const err = new Error('m');
    err.status = 429;
    err.kind = 'http';
    expect(normalizeStreamError(err)).toEqual({ message: 'm', status: 429, kind: 'http' });
  });

  it('accepts Error without status', () => {
    expect(normalizeStreamError(new Error('m'))).toEqual({ message: 'm', status: null, kind: null });
  });
});

describe('AcpClient fetch-path error classification', () => {
  it('marks a malformed JSON response as client error without breaking the connection', async () => {
    const client = makeClient();
    client.requestHttp.mockResolvedValue(okResponse('{"error":'));
    await expect(client.request('session/load', {})).rejects.toMatchObject({ failureClass: 'client' });
    expect(client.markConnectionBroken).not.toHaveBeenCalled();
  });

  it('marks a premature stream end as client error without breaking the connection', async () => {
    const client = makeClient();
    client.requestHttp.mockResolvedValue(okResponse('<html>not the acp endpoint</html>'));
    await expect(client.request('session/load', {})).rejects.toMatchObject({ failureClass: 'client' });
    expect(client.markConnectionBroken).not.toHaveBeenCalled();
  });

  it('answers unknown JSON-RPC requests with -32601 instead of dropping them', async () => {
    const client = makeClient();
    client.requestHttp.mockResolvedValue(okResponse('{}'));
    client.handleIncomingRpc({ jsonrpc: '2.0', method: 'unknown/thing', id: 'req-42', params: {} });
    await vi.waitFor(() => expect(client.requestHttp).toHaveBeenCalled());
    const call = client.requestHttp.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.id).toBe('req-42');
    expect(body.error).toMatchObject({ code: -32601 });
    expect(String(body.error.message)).toContain('Method not found');
  });

  it('respects the auto-reconnect kill switch on heartbeat failure', async () => {
    const client = new AcpClient();
    client.connected = true;
    client.autoReconnectEnabled = false;
    client._maxHeartbeatFailures = 2;
    client.fetchJson = vi.fn().mockRejectedValue(new Error('health down'));
    client._triggerReconnect = vi.fn();
    client.reconnecting = false;
    client.startHeartbeat(20);
    await vi.waitFor(() => expect(client.connected).toBe(false));
    expect(client._triggerReconnect).not.toHaveBeenCalled();
    setApiBase('http://127.0.0.1:63918');
  });

  it('reconnects on heartbeat failure when auto-reconnect is enabled', async () => {
    const client = new AcpClient();
    client.connected = true;
    client.autoReconnectEnabled = true;
    client._maxHeartbeatFailures = 2;
    client.fetchJson = vi.fn().mockRejectedValue(new Error('health down'));
    client._triggerReconnect = vi.fn();
    client.reconnecting = false;
    client.startHeartbeat(20);
    await vi.waitFor(() => expect(client._triggerReconnect).toHaveBeenCalled());
    setApiBase('http://127.0.0.1:63918');
  });
});
