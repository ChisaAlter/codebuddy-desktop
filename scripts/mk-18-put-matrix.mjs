/**
 * Live PUT/readback/restore for WebUI Mk 18 keys against CodeBuddy --serve.
 * Path matches GUI updateSettingByKey: PUT /api/v1/settings/{root}?scope=user { value }
 *
 * Usage:
 *   CODEBUDDY_BASE=http://127.0.0.1:18789 CODEBUDDY_TOKEN=... node scripts/mk-18-put-matrix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const BASE = process.env.CODEBUDDY_BASE || 'http://127.0.0.1:18789';
const TOKEN = process.env.CODEBUDDY_TOKEN || '';
// L15: fail fast with a clear message if the token is missing — an empty bearer
// produces confusing 401s instead of a hint to set the env var.
if (!TOKEN) {
  console.error('CODEBUDDY_TOKEN required: set it to a valid session token before running.');
  process.exit(2);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../docs/parity-evidence');

const MK_KEYS = [
  'model',
  'reasoningEffort',
  'alwaysThinkingEnabled',
  'autoCompactEnabled',
  'includeCoAuthoredBy',
  'fileCheckpointingEnabled',
  'promptSuggestionEnabled',
  'ignoreGitIgnore',
  'deferToolLoading',
  'hookOutputCollapsed',
  'memory.enabled',
  'memory.autoMemoryEnabled',
  'language',
  'cleanupPeriodDays',
  'imageHistoryRetainRounds',
  'env',
  'sandbox.enabled',
  'sandbox.autoAllowBashIfSandboxed',
];

function getByPath(obj, p) {
  return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

function setByPath(obj, p, v) {
  const parts = p.split('.');
  const out = structuredClone(obj ?? {});
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...cur[k] } : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = v;
  return out;
}

// L14: use Node's deep-strict equality instead of JSON.stringify (which is
// order-sensitive on object keys and treats undefined/omitted inconsistently).
function deepEq(a, b) {
  return isDeepStrictEqual(a, b);
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'x-codebuddy-request': '1',
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok || res.status === 204, json, text };
}

function pickProbe(key, current) {
  if (key === 'model') return current === 'hy3' ? 'glm-5.0' : 'hy3';
  if (key === 'reasoningEffort') {
    const opts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    return opts.find((o) => o !== current) || 'medium';
  }
  if (key === 'language') return current === '简体中文' ? 'English' : '简体中文';
  if (key === 'cleanupPeriodDays') return Number(current) === 30 ? 31 : 30;
  if (key === 'imageHistoryRetainRounds') return Number(current || 0) === 5 ? 6 : 5;
  if (key === 'env') {
    const base = current && typeof current === 'object' ? { ...current } : {};
    return { ...base, __parity_probe__: '1' };
  }
  return !Boolean(current);
}

fs.mkdirSync(outDir, { recursive: true });

const results = [];
const all = await api('GET', '/api/v1/settings');
const user = await api('GET', '/api/v1/settings?scope=user');
if (!all.ok || !user.ok) {
  console.error('baseline GET failed', all.status, user.status, all.text, user.text);
  process.exit(1);
}

const baseline = user.json?.data ?? user.json;
const baselineAll = all.json?.data ?? all.json;
fs.writeFileSync(path.join(outDir, 'settings-baseline-user.json'), JSON.stringify(baseline, null, 2));
fs.writeFileSync(path.join(outDir, 'settings-baseline-all.json'), JSON.stringify(baselineAll, null, 2));

for (const key of MK_KEYS) {
  const rootKey = key.split('.')[0];
  const original = getByPath(baseline, key);
  const probe = pickProbe(key, original);
  const row = {
    key,
    rootKey,
    original,
    probe,
    putStatus: null,
    putOk: false,
    readback: null,
    restored: false,
    pass: false,
    notes: '',
  };

  try {
    let payloadValue;
    if (key.includes('.')) {
      const rootObj =
        getByPath(baseline, rootKey) && typeof getByPath(baseline, rootKey) === 'object'
          ? { ...getByPath(baseline, rootKey) }
          : {};
      payloadValue = setByPath({ [rootKey]: rootObj }, key, probe)[rootKey];
    } else if (key === 'env') {
      payloadValue = probe;
    } else {
      payloadValue = probe;
    }

    const put = await api('PUT', `/api/v1/settings/${encodeURIComponent(rootKey)}?scope=user`, {
      value: payloadValue,
    });
    row.putStatus = put.status;
    row.putOk = put.ok;
    if (!put.ok) {
      row.notes = `PUT failed: ${put.status} ${put.text}`;
      results.push(row);
      console.log(`FAIL ${key} ${row.notes}`);
      continue;
    }

    const rb = await api('GET', '/api/v1/settings?scope=user');
    const rbData = rb.json?.data ?? rb.json;
    row.readback = getByPath(rbData, key);
    const writeOk =
      deepEq(row.readback, probe) ||
      (typeof probe === 'boolean' && Boolean(row.readback) === probe) ||
      (key === 'env' && row.readback && row.readback.__parity_probe__ === '1');

    // restore from baseline snapshot for the root
    const baselineRoot = getByPath(baseline, rootKey);
    if (baselineRoot !== undefined) {
      await api('PUT', `/api/v1/settings/${encodeURIComponent(rootKey)}?scope=user`, {
        value: baselineRoot,
      });
    } else if (key.includes('.')) {
      // nested without baseline root: restore sibling object without probe field
      const liveRoot =
        getByPath(rbData, rootKey) && typeof getByPath(rbData, rootKey) === 'object'
          ? { ...getByPath(rbData, rootKey) }
          : {};
      const restoredRoot = setByPath({ [rootKey]: liveRoot }, key, original)[rootKey];
      await api('PUT', `/api/v1/settings/${encodeURIComponent(rootKey)}?scope=user`, {
        value: restoredRoot,
      });
    } else if (original !== undefined) {
      await api('PUT', `/api/v1/settings/${encodeURIComponent(rootKey)}?scope=user`, {
        value: original,
      });
    }

    const rb2 = await api('GET', '/api/v1/settings?scope=user');
    const rb2Data = rb2.json?.data ?? rb2.json;
    const restoredVal = getByPath(rb2Data, key);
    if (key === 'env') {
      const envNow = getByPath(rb2Data, 'env') || {};
      row.restored = !Object.prototype.hasOwnProperty.call(envNow, '__parity_probe__');
    } else if (original === undefined) {
      row.restored = restoredVal === undefined || restoredVal === null || restoredVal === original;
    } else {
      row.restored =
        deepEq(restoredVal, original) ||
        (typeof original === 'boolean' && Boolean(restoredVal) === original);
    }
    row.pass = Boolean(writeOk && row.putOk);
    if (!writeOk) {
      row.notes = `readback mismatch: got ${JSON.stringify(row.readback)} expected ${JSON.stringify(probe)}`;
    }
    if (!row.restored) {
      row.notes = `${row.notes ? `${row.notes}; ` : ''}restore incomplete: now ${JSON.stringify(restoredVal)}`;
    }
  } catch (e) {
    row.notes = String(e && e.stack ? e.stack : e);
  }
  results.push(row);
  console.log(
    `${row.pass ? 'PASS' : 'FAIL'} ${key} put=${row.putStatus} restored=${row.restored} ${row.notes}`,
  );
}

// Final full restore of all baseline roots we may have touched
const roots = [...new Set(MK_KEYS.map((k) => k.split('.')[0]))];
for (const root of roots) {
  if (baseline[root] !== undefined) {
    await api('PUT', `/api/v1/settings/${encodeURIComponent(root)}?scope=user`, {
      value: baseline[root],
    });
  }
}

const summary = {
  at: new Date().toISOString(),
  base: BASE,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).map((r) => r.key),
  restoreIssues: results.filter((r) => !r.restored).map((r) => r.key),
  results: results.map((r) => ({
    key: r.key,
    pass: r.pass,
    putStatus: r.putStatus,
    putOk: r.putOk,
    original: r.original,
    probe: r.probe,
    readback: r.readback,
    restored: r.restored,
    notes: r.notes,
  })),
};

const out = path.join(outDir, 'mk-18-put-matrix.json');
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  `\nSUMMARY ${summary.passed}/${summary.total} failed=${JSON.stringify(summary.failed)} restoreIssues=${JSON.stringify(summary.restoreIssues)}`,
);
console.log('wrote', out);
process.exit(summary.failed.length ? 1 : 0);
