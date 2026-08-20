/**
 * E2EE + relay-auth primitives (NaCl / tweetnacl).
 * Bundle: [nonce 24][ciphertext] — nonce = 16-byte salt + 8-byte LE seq.
 * Wire: base64 text over WebSocket.
 */

import nacl from 'tweetnacl';
import { fromByteArray, toByteArray } from 'base64-js';

export const SALT_LENGTH = 16;
export const SEQ_LENGTH = 8;
const NONCE_LENGTH = nacl.box.nonceLength; // 24

/** @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair */
/** @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} RelayAuthKeyPair */

let prngReady = false;

export function ensurePrng() {
  if (prngReady) return;
  try {
    nacl.randomBytes(1);
    prngReady = true;
    return;
  } catch {
    /* fallthrough */
  }
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    nacl.setPRNG((x, n) => {
      const buf = new Uint8Array(n);
      cryptoObj.getRandomValues(buf);
      x.set(buf, 0);
    });
    prngReady = true;
    return;
  }
  throw new Error('No secure PRNG available for tweetnacl');
}

function encodeBase64(bytes) {
  return fromByteArray(bytes);
}

function decodeBase64(base64) {
  return toByteArray(base64);
}

/**
 * @returns {KeyPair}
 */
export function generateKeyPair() {
  ensurePrng();
  const { publicKey, secretKey } = nacl.box.keyPair();
  return { publicKey, secretKey };
}

/**
 * @param {Uint8Array} publicKey
 */
export function exportPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return encodeBase64(publicKey);
}

/**
 * @param {string} base64
 */
export function importPublicKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return bytes;
}

/**
 * @param {Uint8Array} secretKey
 */
export function exportSecretKey(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  return encodeBase64(secretKey);
}

/**
 * @param {string} base64
 */
export function importSecretKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  return bytes;
}

/**
 * @param {Uint8Array} theirPublicKey
 * @param {Uint8Array} mySecretKey
 * @returns {Uint8Array}
 */
export function deriveSharedKey(theirPublicKey, mySecretKey) {
  return nacl.box.before(theirPublicKey, mySecretKey);
}

/**
 * @returns {RelayAuthKeyPair}
 */
export function generateRelayAuthKeyPair() {
  ensurePrng();
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return { publicKey, secretKey };
}

/**
 * @param {Uint8Array} publicKey
 */
export function exportRelayAuthPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error(`Invalid relay-auth public key length`);
  }
  return encodeBase64(publicKey);
}

/**
 * @param {string} base64
 */
export function importRelayAuthPublicKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error(`Invalid relay-auth public key length`);
  }
  return bytes;
}

/**
 * @param {Uint8Array} secretKey
 */
export function exportRelayAuthSecretKey(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== nacl.sign.secretKeyLength) {
    throw new Error(`Invalid relay-auth secret key length`);
  }
  return encodeBase64(secretKey);
}

/**
 * @param {string} base64
 */
export function importRelayAuthSecretKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.sign.secretKeyLength) {
    throw new Error(`Invalid relay-auth secret key length`);
  }
  return bytes;
}

/**
 * Derive a relay serverId from the host's relay-auth Ed25519 public key so the
 * serverId is cryptographically bound to the host (H9). An attacker using their
 * own keypair gets a different serverId and cannot pre-emptively squat the
 * legitimate host's serverId at the relay.
 *
 * Uses nacl.hash (SHA-512), taking the first 16 bytes, base64url-encoded
 * (padded with '=' stripped to match the existing serverId format).
 * @param {string} relayAuthPublicKeyB64
 * @returns {string} `srv_<base64url(16 bytes)>`
 */
export function deriveServerId(relayAuthPublicKeyB64) {
  const pub = decodeBase64(relayAuthPublicKeyB64);
  if (pub.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('Invalid relay-auth public key length for serverId derivation');
  }
  const digest = nacl.hash(pub); // SHA-512
  const slice = digest.slice(0, 16);
  // base64url without padding
  return `srv_${encodeBase64(slice).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Device authentication (C1/C2/H12)
//
// Each paired mobile device owns a long-lived Ed25519 keypair. Its deviceId is
// derived from the public key so it cannot be impersonated. On every connection
// the device signs a fresh { serverId, deviceId, connectionId, issuedAt }
// challenge; the desktop verifies the signature against the device's stored
// public key before authorizing any op.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DeviceKeyPair
 * @property {Uint8Array} publicKey  32-byte Ed25519 public key
 * @property {Uint8Array} secretKey  64-byte Ed25519 secret key
 */

/** @returns {DeviceKeyPair} */
export function generateDeviceKeyPair() {
  ensurePrng();
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return { publicKey, secretKey };
}

/** @param {Uint8Array} publicKey */
export function exportDevicePublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('Invalid device public key length');
  }
  return encodeBase64(publicKey);
}

/** @param {string} base64 */
export function importDevicePublicKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('Invalid device public key length');
  }
  return bytes;
}

/** @param {Uint8Array} secretKey */
export function exportDeviceSecretKey(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== nacl.sign.secretKeyLength) {
    throw new Error('Invalid device secret key length');
  }
  return encodeBase64(secretKey);
}

/** @param {string} base64 */
export function importDeviceSecretKey(base64) {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== nacl.sign.secretKeyLength) {
    throw new Error('Invalid device secret key length');
  }
  return bytes;
}

/**
 * Canonical message for device connection auth.
 * @param {{ serverId: string, deviceId: string, connectionId: string, issuedAt: number }} fields
 */
export function buildDeviceAuthMessage(fields) {
  return [
    'cb-mobile-remote-device-auth-v1',
    fields.serverId,
    fields.deviceId,
    fields.connectionId,
    String(fields.issuedAt),
  ].join('\n');
}

/**
 * @param {{ serverId: string, deviceId: string, connectionId: string, issuedAt: number }} fields
 * @param {Uint8Array} secretKey
 * @returns {string} base64 signature
 */
export function signDeviceAuth(fields, secretKey) {
  ensurePrng();
  const msg = new TextEncoder().encode(buildDeviceAuthMessage(fields));
  const sig = nacl.sign.detached(msg, secretKey);
  return encodeBase64(sig);
}

/**
 * @param {{ serverId: string, deviceId: string, connectionId: string, issuedAt: number }} fields
 * @param {string} signatureB64
 * @param {Uint8Array} publicKey
 */
export function verifyDeviceAuth(fields, signatureB64, publicKey) {
  const msg = new TextEncoder().encode(buildDeviceAuthMessage(fields));
  const sig = decodeBase64(signatureB64);
  return nacl.sign.detached.verify(msg, sig, publicKey);
}

/**
 * Derive a stable deviceId from a device's Ed25519 public key (H12). The id is
 * deterministic and unforgeable: an attacker cannot claim another device's id
 * without that device's secret key. Uses base32-ish encoding of a SHA-512
 * prefix for a compact, URL-safe id.
 * @param {Uint8Array} devicePublicKey
 * @returns {string} `dev_<base64url(10 bytes)>`
 */
export function deriveDeviceId(devicePublicKey) {
  if (!(devicePublicKey instanceof Uint8Array) || devicePublicKey.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('Invalid device public key length for deviceId derivation');
  }
  const digest = nacl.hash(devicePublicKey); // SHA-512
  const slice = digest.slice(0, 10);
  return `dev_${encodeBase64(slice).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * Canonical message for relay server socket auth.
 * @param {{ serverId: string, role: string, connectionId?: string, nonce: string, issuedAt: number }} fields
 */
export function buildRelayAuthMessage(fields) {
  const connectionId = fields.connectionId || '';
  return [
    'cb-mobile-remote-relay-auth-v1',
    fields.serverId,
    fields.role,
    connectionId,
    fields.nonce,
    String(fields.issuedAt),
  ].join('\n');
}

/**
 * @param {{ serverId: string, role: string, connectionId?: string, nonce: string, issuedAt: number }} fields
 * @param {Uint8Array} secretKey
 * @returns {string} base64 signature
 */
export function signRelayServerAuth(fields, secretKey) {
  ensurePrng();
  const msg = new TextEncoder().encode(buildRelayAuthMessage(fields));
  const sig = nacl.sign.detached(msg, secretKey);
  return encodeBase64(sig);
}

/**
 * @param {{ serverId: string, role: string, connectionId?: string, nonce: string, issuedAt: number }} fields
 * @param {string} signatureB64
 * @param {Uint8Array} publicKey
 */
export function verifyRelayServerAuth(fields, signatureB64, publicKey) {
  const msg = new TextEncoder().encode(buildRelayAuthMessage(fields));
  const sig = decodeBase64(signatureB64);
  return nacl.sign.detached.verify(msg, sig, publicKey);
}

/**
 * Directional encrypt/decrypt with monotonic sequence.
 */
export function createEncryptedChannel(sharedKey) {
  if (!(sharedKey instanceof Uint8Array) || sharedKey.byteLength !== nacl.box.sharedKeyLength) {
    throw new Error('Invalid shared key');
  }
  ensurePrng();
  const sendSalt = nacl.randomBytes(SALT_LENGTH);
  let sendSeq = 0n;
  let recvSalt = null;
  let recvSeq = -1n;

  function writeSeq(seq) {
    const buf = new Uint8Array(SEQ_LENGTH);
    let n = seq;
    for (let i = 0; i < SEQ_LENGTH; i += 1) {
      buf[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return buf;
  }

  function readSeq(bytes) {
    let n = 0n;
    for (let i = SEQ_LENGTH - 1; i >= 0; i -= 1) {
      n = (n << 8n) | BigInt(bytes[i]);
    }
    return n;
  }

  return {
    /**
     * @param {string | Uint8Array} plaintext
     * @returns {string} base64 bundle
     */
    encrypt(plaintext) {
      const plain =
        typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
      const nonce = new Uint8Array(NONCE_LENGTH);
      nonce.set(sendSalt, 0);
      nonce.set(writeSeq(sendSeq), SALT_LENGTH);
      sendSeq += 1n;
      const cipher = nacl.box.after(plain, nonce, sharedKey);
      if (!cipher) throw new Error('encrypt failed');
      const bundle = new Uint8Array(NONCE_LENGTH + cipher.byteLength);
      bundle.set(nonce, 0);
      bundle.set(cipher, NONCE_LENGTH);
      return encodeBase64(bundle);
    },

    /**
     * @param {string} bundleB64
     * @returns {Uint8Array}
     */
    decrypt(bundleB64) {
      const bundle = decodeBase64(bundleB64);
      if (bundle.byteLength <= NONCE_LENGTH) throw new Error('bundle too short');
      const nonce = bundle.subarray(0, NONCE_LENGTH);
      const cipher = bundle.subarray(NONCE_LENGTH);
      const salt = nonce.subarray(0, SALT_LENGTH);
      const seq = readSeq(nonce.subarray(SALT_LENGTH, NONCE_LENGTH));
      if (recvSalt != null) {
        for (let i = 0; i < SALT_LENGTH; i += 1) {
          if (recvSalt[i] !== salt[i]) throw new Error('salt mismatch');
        }
      }
      if (seq <= recvSeq) throw new Error('replay or out-of-order sequence');
      const plain = nacl.box.open.after(cipher, nonce, sharedKey);
      if (!plain) throw new Error('decrypt failed');
      if (recvSalt == null) recvSalt = new Uint8Array(salt);
      recvSeq = seq;
      return plain;
    },

    /**
     * @param {string} bundleB64
     * @returns {string}
     */
    decryptUtf8(bundleB64) {
      return new TextDecoder().decode(this.decrypt(bundleB64));
    },
  };
}

/**
 * Host side: wait for e2ee_hello, reply e2ee_ready, return channel.
 * Client side helpers for the same handshake JSON.
 */

/**
 * @param {string} ephemeralPublicKeyB64
 */
export function buildE2eeHelloMessage(ephemeralPublicKeyB64) {
  return JSON.stringify({ type: 'e2ee_hello', publicKeyB64: ephemeralPublicKeyB64 });
}

/**
 * H14: canonical transcript for the host→client e2ee handshake signature.
 * Binds the host's serverId and the client's ephemeral key so an active MITM
 * cannot substitute its own key into e2ee_hello and read host→client frames.
 * @param {{ serverId: string, clientPublicKeyB64: string, issuedAt: number }} fields
 */
export function buildE2eeHandshakeMessage(fields) {
  return [
    'cb-mobile-remote-e2ee-handshake-v1',
    fields.serverId,
    fields.clientPublicKeyB64,
    String(fields.issuedAt),
  ].join('\n');
}

/**
 * @param {{ serverId: string, clientPublicKeyB64: string, issuedAt: number }} fields
 * @param {Uint8Array} secretKey host relay-auth Ed25519 secret key
 * @returns {string} base64 signature
 */
export function signE2eeHandshake(fields, secretKey) {
  ensurePrng();
  const msg = new TextEncoder().encode(buildE2eeHandshakeMessage(fields));
  const sig = nacl.sign.detached(msg, secretKey);
  return encodeBase64(sig);
}

/**
 * @param {{ serverId: string, clientPublicKeyB64: string, issuedAt: number }} fields
 * @param {string} signatureB64
 * @param {Uint8Array} publicKey host relay-auth Ed25519 public key
 * @returns {boolean}
 */
export function verifyE2eeHandshake(fields, signatureB64, publicKey) {
  const msg = new TextEncoder().encode(buildE2eeHandshakeMessage(fields));
  const sig = decodeBase64(signatureB64);
  return nacl.sign.detached.verify(msg, sig, publicKey);
}

/**
 * Host reply to e2ee_hello. With H14 the host signs the handshake transcript
 * (serverId + client ephemeral key + issuedAt) so the client can authenticate
 * the host before trusting any decrypted payload. The no-arg form produces the
 * legacy unsigned message (kept for tests/back-compat callers).
 * @param {string|null} [sig] base64 Ed25519 signature (H14)
 * @param {{ serverId: string, clientPublicKeyB64: string, issuedAt: number }|null} [meta]
 */
export function buildE2eeReadyMessage(sig = null, meta = null) {
  const o = { type: 'e2ee_ready' };
  if (sig) {
    o.sig = sig;
    o.serverId = meta?.serverId;
    o.clientPublicKeyB64 = meta?.clientPublicKeyB64;
    o.issuedAt = meta?.issuedAt;
  }
  return JSON.stringify(o);
}

/**
 * @param {string} text
 * @returns {{ type: string, publicKeyB64?: string, sig?: string, serverId?: string, issuedAt?: number } | null}
 */
export function parseHandshakeMessage(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') return null;
    if (o.type !== 'e2ee_hello' && o.type !== 'e2ee_ready') return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Client creates ephemeral key, encrypt channel with host long-term public key.
 * @param {Uint8Array} hostPublicKey
 */
export function createClientChannel(hostPublicKey) {
  const ephemeral = generateKeyPair();
  const shared = deriveSharedKey(hostPublicKey, ephemeral.secretKey);
  return {
    ephemeralPublicKeyB64: exportPublicKey(ephemeral.publicKey),
    channel: createEncryptedChannel(shared),
  };
}

/**
 * Host accepts client hello public key.
 * @param {KeyPair} hostKeyPair
 * @param {string} clientPublicKeyB64
 */
export function createHostChannelFromHello(hostKeyPair, clientPublicKeyB64) {
  const clientPub = importPublicKey(clientPublicKeyB64);
  const shared = deriveSharedKey(clientPub, hostKeyPair.secretKey);
  return createEncryptedChannel(shared);
}

/**
 * Persistable key material for Desktop Host.
 * @returns {{ e2ee: { publicKeyB64: string, secretKeyB64: string }, relayAuth: { publicKeyB64: string, secretKeyB64: string } }}
 */
export function generateHostKeyMaterial() {
  const e2ee = generateKeyPair();
  const relayAuth = generateRelayAuthKeyPair();
  return {
    e2ee: {
      publicKeyB64: exportPublicKey(e2ee.publicKey),
      secretKeyB64: exportSecretKey(e2ee.secretKey),
    },
    relayAuth: {
      publicKeyB64: exportRelayAuthPublicKey(relayAuth.publicKey),
      secretKeyB64: exportRelayAuthSecretKey(relayAuth.secretKey),
    },
  };
}

/**
 * @param {{ e2ee: { publicKeyB64: string, secretKeyB64: string } }} material
 * @returns {KeyPair}
 */
export function loadHostE2eeKeyPair(material) {
  return {
    publicKey: importPublicKey(material.e2ee.publicKeyB64),
    secretKey: importSecretKey(material.e2ee.secretKeyB64),
  };
}

/**
 * @param {{ relayAuth: { publicKeyB64: string, secretKeyB64: string } }} material
 * @returns {RelayAuthKeyPair}
 */
export function loadHostRelayAuthKeyPair(material) {
  return {
    publicKey: importRelayAuthPublicKey(material.relayAuth.publicKeyB64),
    secretKey: importRelayAuthSecretKey(material.relayAuth.secretKeyB64),
  };
}
