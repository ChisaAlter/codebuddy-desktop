'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX = 32;

function devicesPath(userDataPath) {
  return path.join(userDataPath, 'mobile-remote-devices.json');
}

function loadDevices(userDataPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(devicesPath(userDataPath), 'utf8'));
    if (raw && Array.isArray(raw.devices)) {
      return raw.devices.filter((d) => d && typeof d.deviceId === 'string').slice(0, DEFAULT_MAX);
    }
  } catch {
    /* missing/corrupt -> empty */
  }
  return [];
}

function saveDevices(userDataPath, devices) {
  const file = devicesPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}

module.exports = { loadDevices, saveDevices, devicesPath, DEFAULT_MAX };