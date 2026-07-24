/**
 * CodeBuddy mobile-remote protocol (v1).
 * Meet-me relay + pairing offer; business ops ride inside E2EE payloads.
 */

export const PROTOCOL_VERSION = 1;
export const CURRENT_RELAY_PROTOCOL_VERSION = '1';
export const DEFAULT_PAIR_SCHEME = 'codebuddy-remote';
export const OFFER_FRAGMENT_PREFIX = '#offer=';

/** @typedef {'server' | 'client'} RelayRole */

/**
 * @typedef {object} ConnectionOfferV1
 * @property {1} v
 * @property {string} serverId
 * @property {string} hostPublicKeyB64
 * @property {string} [relayAuthPublicKeyB64]
 * @property {{ endpoint: string, useTls?: boolean }} relay
 */

/**
 * @param {unknown} value
 * @returns {ConnectionOfferV1}
 */
export function parseConnectionOffer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connection offer must be an object');
  }
  const o = /** @type {Record<string, unknown>} */ (value);
  if (o.v !== 1) {
    throw new Error(`Unsupported offer version: ${String(o.v)}`);
  }
  const serverId = typeof o.serverId === 'string' ? o.serverId.trim() : '';
  if (!serverId) throw new Error('serverId is required');

  const hostPublicKeyB64 =
    typeof o.hostPublicKeyB64 === 'string' ? o.hostPublicKeyB64.trim() : '';
  if (!hostPublicKeyB64) throw new Error('hostPublicKeyB64 is required');

  let relayAuthPublicKeyB64;
  if (o.relayAuthPublicKeyB64 != null) {
    if (typeof o.relayAuthPublicKeyB64 !== 'string' || !o.relayAuthPublicKeyB64.trim()) {
      throw new Error('relayAuthPublicKeyB64 must be a non-empty string when set');
    }
    relayAuthPublicKeyB64 = o.relayAuthPublicKeyB64.trim();
  }

  if (!o.relay || typeof o.relay !== 'object' || Array.isArray(o.relay)) {
    throw new Error('relay is required');
  }
  const relayObj = /** @type {Record<string, unknown>} */ (o.relay);
  const endpoint = typeof relayObj.endpoint === 'string' ? relayObj.endpoint.trim() : '';
  if (!endpoint) throw new Error('relay.endpoint is required');
  const useTls = relayObj.useTls === undefined ? true : Boolean(relayObj.useTls);

  /** @type {ConnectionOfferV1} */
  const offer = {
    v: 1,
    serverId,
    hostPublicKeyB64,
    relay: { endpoint, useTls },
  };
  if (relayAuthPublicKeyB64) offer.relayAuthPublicKeyB64 = relayAuthPublicKeyB64;
  return offer;
}

/**
 * @param {string} input base64url (no padding required)
 * @returns {string} utf-8 json
 */
export function decodeBase64UrlToUtf8(input) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * @param {string} utf8
 * @returns {string} base64url without padding
 */
export function encodeUtf8ToBase64Url(utf8) {
  const bytes = new TextEncoder().encode(utf8);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const base64 = globalThis.btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * @param {ConnectionOfferV1} offer
 * @param {{ appOrigin?: string }} [options]
 * @returns {string}
 */
export function encodeConnectionOfferToUrl(offer, options = {}) {
  const parsed = parseConnectionOffer(offer);
  const encoded = encodeUtf8ToBase64Url(JSON.stringify(parsed));
  const origin = options.appOrigin || `${DEFAULT_PAIR_SCHEME}://pair`;
  return `${origin}${OFFER_FRAGMENT_PREFIX}${encoded}`;
}

/**
 * @param {string} input
 * @returns {ConnectionOfferV1 | null}
 */
export function parseConnectionOfferFromUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  if (!encoded) return null;
  const payload = JSON.parse(decodeBase64UrlToUtf8(encoded));
  return parseConnectionOffer(payload);
}

/**
 * @param {string} input host:port or [ipv6]:port
 * @returns {{ host: string, port: number, isIpv6: boolean }}
 */
export function parseHostPort(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('Host is required');

  if (trimmed.startsWith('[')) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) throw new Error('Invalid host:port (expected [::1]:8787)');
    const host = match[1].trim();
    if (!host) throw new Error('Host is required');
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port must be between 1 and 65535');
    }
    return { host, port, isIpv6: true };
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) throw new Error('Invalid host:port (expected localhost:8787)');
  const host = match[1].trim();
  if (!host) throw new Error('Host is required');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be between 1 and 65535');
  }
  return { host, port, isIpv6: false };
}

/**
 * Build relay WebSocket URL.
 * @param {object} params
 * @param {string} params.endpoint host:port
 * @param {boolean} [params.useTls]
 * @param {string} params.serverId
 * @param {RelayRole} params.role
 * @param {string} [params.connectionId]
 * @param {string} [params.v]
 * @param {Record<string, string>} [params.extraQuery]
 */
export function buildRelayWebSocketUrl(params) {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const useTls = params.useTls !== false;
  const scheme = useTls ? 'wss' : 'ws';
  const hostPart = isIpv6 ? `[${host}]` : host;
  const q = new URLSearchParams();
  q.set('v', params.v || CURRENT_RELAY_PROTOCOL_VERSION);
  q.set('serverId', params.serverId);
  q.set('role', params.role);
  if (params.connectionId) q.set('connectionId', params.connectionId);
  if (params.extraQuery) {
    for (const [k, v] of Object.entries(params.extraQuery)) {
      if (v != null && v !== '') q.set(k, v);
    }
  }
  return `${scheme}://${hostPart}:${port}/ws?${q.toString()}`;
}

/** Business op type constants (payload after E2EE). */
export const Ops = Object.freeze({
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
  LIST_PROJECTS: 'list_projects',
  ENSURE_RUNTIME: 'ensure_runtime',
  LIST_THREADS: 'list_threads',
  CREATE_THREAD: 'create_thread',
  OPEN_THREAD: 'open_thread',
  PROMPT: 'prompt',
  STREAM_EVENT: 'stream_event',
  INTERRUPT: 'interrupt',
  GET_SESSION_OPTIONS: 'get_session_options',
  SET_MODEL: 'set_model',
  SET_MODE: 'set_mode',
  SET_REASONING: 'set_reasoning',
  LIST_MODELS: 'list_models',
  PERMISSION_REQUEST: 'permission_request',
  PERMISSION_RESPOND: 'permission_respond',
  LIST_BACKGROUND_TASKS: 'list_background_tasks',
  TASK_LOGS: 'task_logs',
  NOTIFY: 'notify',
  E2EE_HELLO: 'e2ee_hello',
  E2EE_READY: 'e2ee_ready',
});

/** Relay control-plane message types (plaintext on control socket; Phase 1.1). */
export const RelayControl = Object.freeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  SYNC: 'sync',
  PING: 'ping',
  PONG: 'pong',
});
