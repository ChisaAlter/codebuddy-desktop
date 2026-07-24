'use strict';

/**
 * Mobile-remote Desktop Host skeleton.
 * Phase 0: key material, pairing offer, status IPC.
 * Phase 1: outbound relay + E2EE session + CLI bridge.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { loadOrCreateKeyState, saveKeyState } = require('./keys.cjs');

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
   * @param {{ userDataPath: string, getConfig?: () => MobileRemoteConfig, setConfig?: (c: MobileRemoteConfig) => void }} options
   */
  constructor(options) {
    this.userDataPath = options.userDataPath;
    this.getConfig = options.getConfig || defaultConfig;
    this.setConfig = options.setConfig || (() => {});
    this.state = loadOrCreateKeyState(this.userDataPath);
    this._crypto = null;
    this._protocol = null;
    this._relayWs = null;
    this._status = {
      running: false,
      relayConnected: false,
      lastError: null,
      serverId: this.state.serverId,
    };
  }

  async _loadPackages() {
    if (this._crypto && this._protocol) return;
    const root = path.join(__dirname, '..', '..', 'packages');
    const cryptoUrl = pathToFileURL(
      path.join(root, 'mobile-remote-crypto', 'src', 'index.js'),
    ).href;
    const protocolUrl = pathToFileURL(
      path.join(root, 'mobile-remote-protocol', 'src', 'index.js'),
    ).href;
    this._crypto = await import(cryptoUrl);
    this._protocol = await import(protocolUrl);
  }

  async ensureMaterial() {
    await this._loadPackages();
    if (!this.state.material) {
      this.state.material = this._crypto.generateHostKeyMaterial();
      this.state.serverId =
        this.state.serverId || `srv_${require('crypto').randomBytes(16).toString('base64url')}`;
      saveKeyState(this.userDataPath, this.state);
    }
    this._status.serverId = this.state.serverId;
    return this.state;
  }

  getStatus() {
    const cfg = this.getConfig();
    return {
      ...this._status,
      enabled: Boolean(cfg.enabled),
      relayEndpoint: cfg.relayEndpoint,
      relayUseTls: Boolean(cfg.relayUseTls),
      hasKeys: Boolean(this.state.material),
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
   * Phase 0/1: start means "enabled + try connect". Full relay client in next slice.
   */
  async start() {
    await this.ensureMaterial();
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this._status.lastError = 'mobile remote is disabled in config';
      return this.getStatus();
    }
    this._status.running = true;
    this._status.lastError = null;
    // Outbound relay connection lands in Phase 1 (host-relay-transport).
    this._status.relayConnected = false;
    this._status.lastError =
      'relay outbound not yet connected (Phase 1 transport pending); pairing offer is ready';
    return this.getStatus();
  }

  async stop() {
    this._status.running = false;
    this._status.relayConnected = false;
    if (this._relayWs) {
      try {
        this._relayWs.close();
      } catch {
        /* ignore */
      }
      this._relayWs = null;
    }
    this._status.lastError = null;
    return this.getStatus();
  }
}

module.exports = {
  MobileRemoteHost,
  defaultConfig,
};
