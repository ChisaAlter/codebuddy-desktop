'use strict';

/**
 * Mobile-remote Desktop Host: orchestrates keys, outbound relay transport, and
 * the bridge to local CodeBuddy runtimes. Default off; lifecycle tied to app.
 */

const { pathToFileURL } = require('url');
const path = require('path');
const { loadOrCreateKeyState, saveKeyState } = require('./keys.cjs');
const { createBridge } = require('./bridge.cjs');
const { startHostRelayTransport } = require('./transport.cjs');
const { loadDevices, saveDevices } = require('./devices.cjs');

/**
 * @typedef {object} MobileRemoteConfig
 * @property {boolean} enabled
 * @property {string} relayEndpoint
 * @property {boolean} relayUseTls
 */

const defaultConfig = () => ({
  enabled: false,
  relayEndpoint: '127.0.0.1:8787',
  // H14: TLS on by default — plaintext ws:// lets any Wi-Fi-level attacker read
  // and forge the E2EE handshake (client→host auth still holds, but the salt
  // lock and handshake signature rely on transport integrity). Users hosting a
  // relay behind their own TLS terminator can still opt out explicitly.
  relayUseTls: true,
});

class MobileRemoteHost {
  /**
   * @param {object} options
   * @param {string} options.userDataPath
   * @param {() => MobileRemoteConfig} [options.getConfig]
   * @param {(c: MobileRemoteConfig) => void} [options.setConfig]
   * @param {import('electron').Net} [options.net]
   * @param {object} [options.runtimeManager]
   * @param {() => any} [options.getProductState]
   * @param {() => any[]} [options.listBackgroundTasks]
   * @param {(...a: unknown[]) => void} [options.log]
   */
  constructor(options) {
    this.userDataPath = options.userDataPath;
    this.getConfig = options.getConfig || defaultConfig;
    this.setConfig = options.setConfig || (() => {});
    this.net = options.net;
    this.runtimeManager = options.runtimeManager;
    this.getProductState = options.getProductState || (() => null);
    this.listBackgroundTasks = options.listBackgroundTasks || (() => []);
    this.log = options.log || (() => {});
    this.state = loadOrCreateKeyState(this.userDataPath);
    this.devices = loadDevices(this.userDataPath, { log: (msg) => this.log(msg) });
    /** @type {Map<string, string>} connectionId -> deviceId (for current connections) */
    this.connectionDeviceMap = new Map();
    /** @type {Set<string>} connectionIds that have passed device-auth (C1) */
    this.authenticatedConnections = new Set();
    /** @type {Map<string, { token: string, expireAt: number }>} active one-time pairing tokens (C1) */
    this.activePairingTokens = new Map();
    this._crypto = null;
    this._protocol = null;
    this._transport = null;
    this._bridge = null;
    // S3: single-flight for start() and a generation counter so a stop() that
    // runs while start() is still connecting forces the late transport down.
    this._startPromise = null;
    this._startGeneration = null;
    this._generation = 0;
    this._status = {
      running: false,
      relayConnected: false,
      lastError: null,
      serverId: this.state.serverId,
      clientCount: 0,
    };
  }

  async _loadPackages() {
    if (this._crypto && this._protocol) return;
    const root = path.join(__dirname, '..', '..', 'packages');
    const cryptoUrl = pathToFileURL(path.join(root, 'mobile-remote-crypto', 'src', 'index.js')).href;
    const protocolUrl = pathToFileURL(path.join(root, 'mobile-remote-protocol', 'src', 'index.js')).href;
    this._crypto = await import(cryptoUrl);
    this._protocol = await import(protocolUrl);
  }

  async ensureMaterial() {
    await this._loadPackages();
    let changed = false;
    if (!this.state.material) {
      this.state.material = this._crypto.generateHostKeyMaterial();
      changed = true;
    }
    // H9: serverId is derived from the relay-auth public key so it is bound to
    // the host's keypair. The relay rejects any signed connection whose serverId
    // does not derive from the presented public key, so an attacker using their
    // own keypair gets a different serverId and cannot pre-emptively squat the
    // legitimate host's serverId. Legacy random serverIds are migrated here
    // (mobile-remote never shipped with the old format, so no forced re-pair).
    const relayAuthPub = this.state.material.relayAuth.publicKeyB64;
    const derived = this._crypto.deriveServerId(relayAuthPub);
    if (this.state.serverId !== derived) {
      if (this.state.serverId) this.log('migrating serverId to key-derived id (relay requires binding)');
      this.state.serverId = derived;
      changed = true;
    }
    if (changed) saveKeyState(this.userDataPath, this.state);
    this._status.serverId = this.state.serverId;
    return this.state;
  }

  _loadKeyPairs() {
    return {
      e2ee: this._crypto.loadHostE2eeKeyPair(this.state.material),
      relayAuth: this._crypto.loadHostRelayAuthKeyPair(this.state.material),
    };
  }

  getStatus() {
    const cfg = this.getConfig();
    const stats = this._transport?.getStats?.() || { controlOnline: false, clients: [] };
    return {
      ...this._status,
      enabled: Boolean(cfg.enabled),
      relayEndpoint: cfg.relayEndpoint,
      relayUseTls: Boolean(cfg.relayUseTls),
      hasKeys: Boolean(this.state.material),
      relayConnected: Boolean(stats.controlOnline),
      clientCount: stats.clients?.length || 0,
      clients: stats.clients || [],
    };
  }

  /**
   * @param {{ pairingToken?: string }} [options]
   * @returns {Promise<{ offerUrl: string, offer: object, qrPayload: string }>}
   */
  async getPairingOffer(options = {}) {
    await this.ensureMaterial();
    const cfg = this.getConfig();
    const offer = {
      v: 1,
      serverId: this.state.serverId,
      hostPublicKeyB64: this.state.material.e2ee.publicKeyB64,
      relayAuthPublicKeyB64: this.state.material.relayAuth.publicKeyB64,
      relay: {
        endpoint: cfg.relayEndpoint,
        useTls: Boolean(cfg.relayUseTls),
      },
    };
    // C1: embed a one-time pairing token so a new device can pair even when the
    // trust store is non-empty. The token is consumed on first use.
    if (options.pairingToken) {
      offer.pairingToken = options.pairingToken;
    }
    // M-mr7: expire the pairing offer after 10 minutes so a captured QR/offer
    // cannot be used to pair indefinitely. Reconnect (device_auth) ignores exp.
    offer.exp = Date.now() + 10 * 60 * 1000;
    const offerUrl = this._protocol.encodeConnectionOfferToUrl(offer);
    return { offerUrl, offer, qrPayload: offerUrl };
  }

  /**
   * Generate a fresh one-time pairing token (C1). The token must be embedded in
   * the offer via getPairingOffer({ pairingToken }) and is consumed when a
   * device_pair op presents it. Returns the token string.
   * @param {number} [ttlMs=300000] 5 minutes by default
   * @returns {string}
   */
  generatePairingToken(ttlMs = 5 * 60 * 1000) {
    const token = require('crypto').randomBytes(9).toString('base64url');
    this.activePairingTokens.set(token, { token, expireAt: Date.now() + ttlMs });
    // Prune expired tokens opportunistically.
    const now = Date.now();
    for (const [k, v] of this.activePairingTokens) {
      if (v.expireAt <= now) this.activePairingTokens.delete(k);
    }
    return token;
  }

  /**
   * Consume a pairing token: returns true if the token is valid & unexpired and
   * removes it (single-use). @param {string} token @returns {boolean}
   */
  _consumePairingToken(token) {
    if (!token) return false;
    const entry = this.activePairingTokens.get(token);
    if (!entry) return false;
    this.activePairingTokens.delete(token);
    return entry.expireAt > Date.now();
  }

  /**
   * Build the bridge + transport and connect to the relay.
   * S3: single-flight — two concurrent start() calls (e.g. `mobileRemote:start`
   * IPC racing `mobileRemote:setConfig` with enabled=true) share one in-flight
   * promise instead of each spawning a transport, and a stop() that lands while
   * start() is still connecting is honored by _startInner's generation check.
   */
  async start() {
    if (this._startPromise) {
      // S3b: a stop() that landed since the in-flight start began means that
      // promise will tear down its late transport and resolve with
      // running=false. Returning it would silently lose THIS start request
      // (user toggles enable on, nothing connects). Wait for the old work to
      // settle, then start fresh with the current generation.
      if (this._startGeneration !== this._generation) {
        await this._startPromise.catch(() => {});
        this._startPromise = null;
        return this.start();
      }
      return this._startPromise;
    }
    const generation = this._generation;
    this._startGeneration = generation;
    const work = this._startInner(generation).finally(() => {
      if (this._startPromise === work) {
        this._startPromise = null;
        this._startGeneration = null;
      }
    });
    this._startPromise = work;
    return work;
  }

  async _startInner(generation) {
    await this.ensureMaterial();
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this._status.lastError = 'mobile remote is disabled in config';
      return this.getStatus();
    }
    if (!this.net || !this.runtimeManager) {
      this._status.running = true;
      this._status.lastError = 'Host running without net/runtime wiring (test mode)';
      return this.getStatus();
    }

    if (!this._bridge) {
      this._bridge = createBridge({
        net: this.net,
        runtimeManager: this.runtimeManager,
        getProductState: this.getProductState,
        listBackgroundTasks: this.listBackgroundTasks,
        registerDevice: ({ deviceId, label, connectionId }) => {
          return this._registerDevice(deviceId, label, connectionId);
        },
        listDevices: () => this.listDevices(),
        revokeDevice: (deviceId, requestingDeviceId) => {
          return this._revokeDevice(String(deviceId || ''), requestingDeviceId);
        },
        // C1/C2/H12: device authentication & pairing hooks.
        authenticateDevice: ({ deviceId, connectionId, signedChallenge, issuedAt }) =>
          this._authenticateDevice(deviceId, connectionId, signedChallenge, issuedAt),
        pairDevice: ({ publicKeyB64, label, connectionId, pairingToken, signedChallenge, issuedAt }) =>
          this._pairDevice(publicKeyB64, label, connectionId, pairingToken, signedChallenge, issuedAt),
        serverId: () => this.state.serverId,
        log: (...args) => this.log('bridge:', ...args),
      });
    }

    if (this._transport) {
      await this._transport.stop().catch(() => {});
      this._transport = null;
    }

    const { e2ee, relayAuth } = this._loadKeyPairs();
    this._status.running = true;
    this._status.lastError = null;

    this._transport = await startHostRelayTransport({
      endpoint: cfg.relayEndpoint,
      useTls: cfg.relayUseTls,
      serverId: this.state.serverId,
      e2eeKeyPair: e2ee,
      relayAuthKeyPair: relayAuth,
      log: (...args) => this.log('transport:', ...args),
      handlers: {
        onClientReady: async (client) => {
          this.log('client ready', client.connectionId);
          this._status.clientCount = (this._transport?.getStats?.()?.clients?.length) || 0;
          // C1: send the relay-assigned connectionId to the client so it can sign
          // the device-auth challenge with it. This is sent encrypted (post-e2ee).
          try {
            client.ws.send(JSON.stringify({
              type: 'server_frame',
              connectionId: client.connectionId,
              payload: client.channel.encrypt(JSON.stringify({
                type: 'connected',
                connectionId: client.connectionId,
                serverId: this.state.serverId,
              })),
            }));
          } catch (_) {}
        },
        onClientMessage: async (client, plaintext) => {
          let op;
          try { op = JSON.parse(plaintext); } catch {
            this.log('client sent non-JSON', client.connectionId);
            return;
          }
          const ctx = {
            send: (message) => {
              if (!client.channel || !client.ready) return;
              const bundle = client.channel.encrypt(JSON.stringify(message));
              const wrapped = JSON.stringify({
                type: 'server_frame',
                connectionId: client.connectionId,
                payload: bundle,
              });
              try { client.ws.send(wrapped); } catch (_) {}
            },
            // C1: per-connection auth state. The bridge consults these to gate ops.
            connectionId: client.connectionId,
            authenticated: this.authenticatedConnections.has(client.connectionId),
            deviceId: this.connectionDeviceMap.get(client.connectionId) || null,
          };
          await this._bridge.dispatch(ctx, op);
        },
        onClientClose: (client) => {
          // C1/C2: clean up auth state for the closed connection so a reconnect
          // must re-authenticate, and a revoked device cannot keep its slot.
          const cid = client && client.connectionId;
          if (cid) {
            this.authenticatedConnections.delete(cid);
            this.connectionDeviceMap.delete(cid);
          }
          this._status.clientCount = this._transport?.getStats?.()?.clients?.length || 0;
        },
      },
    });

    this._status.relayConnected = Boolean(this._transport?.getStats?.()?.controlOnline);
    // S3: stop() ran while start() was connecting — the switch is off, so tear
    // down the freshly connected transport instead of leaving it online.
    if (this._generation !== generation) {
      await this._transport.stop().catch(() => {});
      this._transport = null;
      this._status.running = false;
      this._status.relayConnected = false;
    }
    return this.getStatus();
  }

  async stop() {
    // S3: bump the generation first so any start() still in flight tears down
    // its late transport (see _startInner), then drop per-connection auth state
    // so stale sockets cannot act authenticated after the stop.
    this._generation += 1;
    this._status.running = false;
    this._status.relayConnected = false;
    this._status.clientCount = 0;
    this.authenticatedConnections.clear();
    this.connectionDeviceMap.clear();
    const transport = this._transport;
    this._transport = null;
    if (transport) {
      await transport.stop().catch(() => {});
    }
    this._status.lastError = null;
    return this.getStatus();
  }

  /**
   * Broadcast a message to all connected clients that have passed device-auth.
   * S2: the E2EE handshake alone (public QR key) must not grant access to task
   * notifications — only connections that completed `device_auth` receive them.
   * @param {object} message
   */
  broadcast(message) {
    if (!this._transport) return;
    try {
      this._transport.broadcast(message, (connectionId) =>
        this.authenticatedConnections.has(connectionId),
      );
    } catch (_) {}
  }

  listDevices() {
    return this.devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || '',
      addedAt: d.addedAt || null,
      lastSeenAt: d.lastSeenAt || null,
    }));
  }

  /**
   * C1: verify a device's per-connection auth signature and mark the connection
   * authenticated on success. The device must already be in the trust store
   * (paired via device_pair). @returns {{ ok: true } | { ok: false, error: string }}
   */
  _authenticateDevice(deviceId, connectionId, signedChallenge, issuedAt) {
    if (!deviceId || !connectionId || !signedChallenge) {
      return { ok: false, error: 'missing auth fields' };
    }
    const skew = Math.abs(Date.now() - Number(issuedAt));
    if (!Number.isFinite(issuedAt) || skew > 60 * 1000) {
      return { ok: false, error: 'issuedAt out of range' };
    }
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (!device || !device.publicKeyB64) {
      return { ok: false, error: 'unknown device' };
    }
    let pub;
    try { pub = this._crypto.importDevicePublicKey(device.publicKeyB64); } catch (_) {
      return { ok: false, error: 'invalid stored device public key' };
    }
    let valid = false;
    try {
      valid = this._crypto.verifyDeviceAuth(
        { serverId: this.state.serverId, deviceId, connectionId, issuedAt: Number(issuedAt) },
        signedChallenge,
        pub,
      );
    } catch (_) {
      // Malformed (non-base64) signature from a hostile client must be a clean
      // auth failure, not an exception that escapes the dispatch.
      return { ok: false, error: 'auth_failed' };
    }
    if (!valid) return { ok: false, error: 'auth_failed' };
    this.authenticatedConnections.add(connectionId);
    this.connectionDeviceMap.set(connectionId, deviceId);
    device.lastSeenAt = Date.now();
    try { saveDevices(this.userDataPath, this.devices); } catch (_) {}
    return { ok: true };
  }

  /**
   * C1: pair a new device. Allowed when the trust store is empty (first device,
   * no token needed) or when a valid one-time pairing token is presented. Verifies
   * the client's signature over { serverId, deviceId, connectionId, issuedAt }
   * (deviceId is derived from the presented public key, so the host signs the
   * derived id back into the challenge for the client to construct — actually the
   * client signs using its own derived deviceId which the host re-derives here).
   * Stores the device's Ed25519 public key, marks the connection authenticated,
   * and returns the derived deviceId.
   * @returns {{ ok: true, deviceId: string } | { ok: false, error: string }}
   */
  _pairDevice(publicKeyB64, label, connectionId, pairingToken, signedChallenge, issuedAt) {
    if (!publicKeyB64 || !connectionId) {
      return { ok: false, error: 'missing publicKey or connectionId' };
    }
    let pub;
    let deviceId;
    try {
      pub = this._crypto.importDevicePublicKey(publicKeyB64);
      deviceId = this._crypto.deriveDeviceId(pub);
    } catch (_) {
      return { ok: false, error: 'invalid device public key' };
    }
    // The client MUST prove possession of the device secret key by signing the
    // device-auth challenge (serverId, deviceId, connectionId, issuedAt). This
    // is mandatory: without it, a stolen QR + pairingToken + forged publicKeyB64
    // could pair without proving key ownership and hijack an existing deviceId.
    if (!signedChallenge) {
      return { ok: false, error: 'signedChallenge required' };
    }
    {
      const skew = Math.abs(Date.now() - Number(issuedAt));
      if (!Number.isFinite(issuedAt) || skew > 60 * 1000) {
        return { ok: false, error: 'issuedAt out of range' };
      }
      let valid = false;
      try {
        valid = this._crypto.verifyDeviceAuth(
          { serverId: this.state.serverId, deviceId, connectionId, issuedAt: Number(issuedAt) },
          signedChallenge,
          pub,
        );
      } catch (_) {
        // Malformed (non-base64) signature must fail cleanly, not throw.
        return { ok: false, error: 'pair signature verification failed' };
      }
      if (!valid) return { ok: false, error: 'pair signature verification failed' };
    }
    // When devices already exist, a pairing token is required to authorize a new
    // device (prevents a stolen QR from auto-pairing). The first device pairs free.
    // M-mr3: consume the token only AFTER the signature verified, so a token
    // holder without the device secret key cannot burn the one-time token.
    const requiresToken = this.devices.length > 0;
    if (requiresToken && !this._consumePairingToken(pairingToken)) {
      return { ok: false, error: 'invalid or expired pairing token' };
    }
    const now = Date.now();
    const existing = this.devices.find((d) => d.deviceId === deviceId);
    if (existing) {
      // Re-pairing the same device updates its label/publicKey and refreshes lastSeen.
      existing.label = label || existing.label;
      existing.publicKeyB64 = publicKeyB64;
      existing.lastSeenAt = now;
    } else {
      if (this.devices.length >= 64) return { ok: false, error: 'device limit reached' };
      this.devices.push({ deviceId, publicKeyB64, label: label || '', addedAt: now, lastSeenAt: now });
    }
    this.connectionDeviceMap.set(connectionId, deviceId);
    this.authenticatedConnections.add(connectionId);
    try { saveDevices(this.userDataPath, this.devices); } catch (err) {
      this.log('saveDevices failed', err?.message || err);
    }
    return { ok: true, deviceId };
  }

  _registerDevice(deviceId, label, connectionId) {
    // C1: device_register only updates the label for an already-paired device
    // (the device must be authenticated, and deviceId must match the connection's
    // authenticated deviceId). First-time identity is established via device_pair.
    if (!deviceId) return { error: 'deviceId required' };
    const existing = this.devices.find((d) => d.deviceId === deviceId);
    if (!existing) return { error: 'device not paired' };
    const now = Date.now();
    existing.label = label || existing.label;
    existing.lastSeenAt = now;
    if (connectionId) this.connectionDeviceMap.set(connectionId, deviceId);
    try { saveDevices(this.userDataPath, this.devices); } catch (err) {
      this.log('saveDevices failed', err?.message || err);
    }
    return { ok: true };
  }

  /**
   * C2: revoke a device, terminate its active connection, and clear its auth
   * state. @param {string} deviceId @param {string|null} requestingDeviceId the
   * deviceId of the caller (must be authenticated). @returns {{ ok: true, revoked: boolean } | { ok: false, error: string }}
   */
  _revokeDevice(deviceId, requestingDeviceId) {
    if (!deviceId) return { ok: false, error: 'deviceId required' };
    // H12/C2: a device may only revoke itself or be revoked by the first (admin)
    // device. The bridge has already verified the caller is authenticated, but we
    // double-check the deviceId-vs-requester rule here.
    const isFirstDevice = this.devices.length > 0 && this.devices[0].deviceId === requestingDeviceId;
    if (requestingDeviceId && requestingDeviceId !== deviceId && !isFirstDevice) {
      return { ok: false, error: 'only a device may revoke itself, or the first (admin) device may revoke others' };
    }
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    const revoked = this.devices.length !== before;
    if (revoked) {
      // C2: terminate any active connection mapped to this deviceId and clear auth.
      for (const [cid, devId] of this.connectionDeviceMap) {
        if (devId === deviceId) {
          this.authenticatedConnections.delete(cid);
          if (this._transport && typeof this._transport.kickConnection === 'function') {
            try { this._transport.kickConnection(cid); } catch (_) {}
          }
          this.connectionDeviceMap.delete(cid);
        }
      }
      try { saveDevices(this.userDataPath, this.devices); } catch (err) {
        this.log('saveDevices failed', err?.message || err);
      }
    }
    return { ok: true, revoked };
  }

  async revokeDevice(deviceId) {
    // Public API does not supply a requestingDeviceId (desktop-side admin action).
    return this._revokeDevice(String(deviceId || ''), null);
  }
}

module.exports = {
  MobileRemoteHost,
  defaultConfig,
};