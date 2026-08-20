'use strict';

const fs = require('fs');
const path = require('path');

// M-mr6: keep the persisted cap identical to the runtime cap enforced in
// host.cjs `_pairDevice` (64), otherwise devices 33-64 are silently dropped on
// restart with no way to revoke them from the UI.
const DEFAULT_MAX = 64;

function devicesPath(userDataPath) {
  return path.join(userDataPath, 'mobile-remote-devices.json');
}

function loadDeviceStore(userDataPath, options = {}) {
  const log = options.log || (() => {});
  try {
    const raw = JSON.parse(fs.readFileSync(devicesPath(userDataPath), 'utf8'));
    if (raw && Array.isArray(raw.devices)) {
      // C1: every device entry must carry a stored Ed25519 public key so the
      // desktop can verify per-connection device-auth signatures. Entries from
      // before device-auth was introduced lack publicKeyB64 and are dropped (the
      // user must re-pair those devices). deviceId remains the join key.
      const filtered = raw.devices.filter(
        (d) =>
          d &&
          typeof d.deviceId === 'string' &&
          typeof d.publicKeyB64 === 'string' &&
          d.publicKeyB64.trim(),
      );
      const droppedCount = raw.devices.length - filtered.length;
      if (droppedCount > 0) {
        log(`devices: dropped ${droppedCount} legacy device(s) missing publicKeyB64 (re-pair required)`);
      }
      const devices = filtered.slice(0, DEFAULT_MAX);
      const adminDeviceId =
        typeof raw.adminDeviceId === 'string' &&
        raw.adminDeviceId.trim() &&
        devices.some((d) => d.deviceId === raw.adminDeviceId)
          ? raw.adminDeviceId
          : null;
      return { devices, adminDeviceId };
    }
  } catch {
    /* missing/corrupt -> empty */
  }
  return { devices: [], adminDeviceId: null };
}

function loadDevices(userDataPath, options = {}) {
  return loadDeviceStore(userDataPath, options).devices;
}

function saveDevices(userDataPath, devices, extra = {}) {
  const file = devicesPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const adminDeviceId =
    typeof extra.adminDeviceId === 'string' && extra.adminDeviceId.trim() ? extra.adminDeviceId : null;
  fs.writeFileSync(tmp, JSON.stringify({ devices, adminDeviceId }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}

module.exports = { loadDevices, loadDeviceStore, saveDevices, devicesPath, DEFAULT_MAX };