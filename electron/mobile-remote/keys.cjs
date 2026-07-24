'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Minimal CJS key store for Desktop Host until packages are loaded via dynamic import.
 * Full crypto stays in @codebuddy/mobile-remote-crypto; this module only persists JSON.
 */

/**
 * @param {string} userDataPath
 */
function keysPath(userDataPath) {
  return path.join(userDataPath, 'mobile-remote-keys.json');
}

/**
 * @param {string} userDataPath
 * @returns {{ serverId: string, material: object }}
 */
function loadOrCreateKeyState(userDataPath) {
  const file = keysPath(userDataPath);
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.serverId && raw.material?.e2ee && raw.material?.relayAuth) {
        return raw;
      }
    }
  } catch {
    /* recreate */
  }

  // Placeholder material — real NaCl keys generated asynchronously via ensureCryptoMaterial
  const state = {
    serverId: `srv_${crypto.randomBytes(16).toString('base64url')}`,
    material: null,
    createdAt: new Date().toISOString(),
  };
  return state;
}

/**
 * @param {string} userDataPath
 * @param {object} state
 */
function saveKeyState(userDataPath, state) {
  const file = keysPath(userDataPath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows may ignore */
  }
}

module.exports = {
  keysPath,
  loadOrCreateKeyState,
  saveKeyState,
};
