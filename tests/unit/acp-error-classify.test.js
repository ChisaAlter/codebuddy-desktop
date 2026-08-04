import { describe, expect, it } from 'vitest';
import { classifyTransportFailure, normalizeStreamError } from '../../src/lib/acp';

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
