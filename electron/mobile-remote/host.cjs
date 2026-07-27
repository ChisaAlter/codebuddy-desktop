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
  relayUseTls: false,
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
    this.devices = loadDevices(this.userDataPath);
    /** @type {Map<string, string>} connectionId -> deviceId (for current connections) */
    this.connectionDeviceMap = new Map();
    this._crypto = null;
    this._protocol = null;
    this._transport = null;
    this._bridge = null;
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
    if (!this.state.material) {
      this.state.material = this._crypto.generateHostKeyMaterial();
      // H9: derive serverId from the relay-auth public key so it is bound to the
      // host's keypair. An attacker using their own keypair gets a different
      // serverId and cannot pre-emptively squat the legitimate host's serverId at
      // the relay. Existing material keeps its already-issued random serverId for
      // backward compatibility (no forced re-pair of already-paired devices).
      const relayAuthPub = this.state.material.relayAuth.publicKeyB64;
      this.state.serverId =
        this.state.serverId || this._crypto.deriveServerId(relayAuthPub);
      saveKeyState(this.userDataPath, this.state);
    }
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
   * @returns {Promise<{ offerUrl: string, offer: object, qrPayload: string }>}
   */
  async getPairingOffer() {
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
    const offerUrl = this._protocol.encodeConnectionOfferToUrl(offer);
    return { offerUrl, offer, qrPayload: offerUrl };
  }

  /**
   * Build the bridge + transport and connect to the relay.
   */
  async start() {
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
        revokeDevice: (deviceId) => this._revokeDevice(deviceId),
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
          };
          await this._bridge.dispatch(ctx, op);
        },
        onClientClose: () => {
          this._status.clientCount = this._transport?.getStats?.()?.clients?.length || 0;
        },
      },
    });

    this._status.relayConnected = Boolean(this._transport?.getStats?.()?.controlOnline);
    return this.getStatus();
  }

  async stop() {
    this._status.running = false;
    this._status.relayConnected = false;
    this._status.clientCount = 0;
    if (this._transport) {
      await this._transport.stop().catch(() => {});
      this._transport = null;
    }
    this._status.lastError = null;
    return this.getStatus();
  }

  /**
   * Broadcast a message to all connected, E2EE-ready clients.
   * @param {object} message
   */
  broadcast(message) {
    if (!this._transport) return;
    try { this._transport.broadcast(message); } catch (_) {}
  }

  listDevices() {
    return this.devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || '',
      addedAt: d.addedAt || null,
      lastSeenAt: d.lastSeenAt || null,
    }));
  }

  _registerDevice(deviceId, label, connectionId) {
    if (!deviceId) return { error: 'deviceId required' };
    const existing = this.devices.find((d) => d.deviceId === deviceId);
    const now = Date.now();
    if (existing) {
      existing.label = label || existing.label;
      existing.lastSeenAt = now;
    } else {
      if (this.devices.length >= 64) {
        return { error: 'device limit reached' };
      }
      this.devices.push({ deviceId, label, addedAt: now, lastSeenAt: now });
    }
    if (connectionId) this.connectionDeviceMap.set(connectionId, deviceId);
    try { saveDevices(this.userDataPath, this.devices); } catch (err) {
      this.log('saveDevices failed', err?.message || err);
    }
    return { ok: true };
  }

  _revokeDevice(deviceId) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    if (this.devices.length !== before) {
      try { saveDevices(this.userDataPath, this.devices); } catch (err) {
        this.log('saveDevices failed', err?.message || err);
      }
    }
    return { ok: true, revoked: this.devices.length !== before };
  }

  async revokeDevice(deviceId) {
    return this._revokeDevice(String(deviceId || ''));
  }
}

module.exports = {
  MobileRemoteHost,
  defaultConfig,
};