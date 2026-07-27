/**
 * Capture WebUI vs GUI settings section crops and compute pixel metrics.
 * Requires agent-browser sessions: parity-web, parity-gui (already logged in).
 *
 * Usage:
 *   node scripts/parity-capture-sections.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'parity-evidence');
const AB = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'agent-browser.cmd')
  : 'agent-browser';

const SECTIONS = [
  'settings-section-appearance',
  'settings-section-model',
  'settings-section-settings-group-modelAndReasoning',
  'settings-section-settings-group-behavior',
  'settings-section-settings-group-memory',
  'settings-section-settings-group-language',
  'settings-section-settings-group-advanced',
  'settings-section-settings-group-sandbox',
];

function ab(session, args, input) {
  const r = spawnSync(
    process.platform === 'win32' ? 'cmd' : AB,
    process.platform === 'win32' ? ['/c', AB, '--session', session, ...args] : ['--session', session, ...args],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      input: input || undefined,
      cwd: ROOT,
    },
  );
  return {
    code: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

function parseJsonLoose(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith('{') || line.startsWith('[') || (line.startsWith('"') && line.endsWith('"'))) {
      try {
        return JSON.parse(line);
      } catch {
        /* continue */
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function abEval(session, js) {
  // Write JS to temp file to avoid shell escaping issues
  const tmp = path.join(OUT, `_eval_${session}.js`);
  fs.writeFileSync(tmp, js, 'utf8');
  // agent-browser eval reads expression as arg — use file content
  const expr = fs.readFileSync(tmp, 'utf8');
  const { out } = ab(session, ['eval', expr]);
  // L11: clean up the temp file after use (previously overwritten each call but
  // never deleted, accumulating one per session).
  try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  return parseJsonLoose(out);
}

function shortId(id) {
  return id.replace('settings-section-', '');
}

// L13: use a Node timer instead of shelling out to Windows `timeout /t N` (which
// only accepts integer seconds — sleep(350) became 1s). Now async; callers must
// await. Kept synchronous-callable via spawnSync fallback removed.
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadPng(file) {
  // Prefer sharp if present; else dynamic import pngjs-free via pure decode with 'pngjs' if available; fallback to child python
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line import/no-extraneous-dependencies
    const sharp = require('sharp');
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch {
    /* use python */
  }
  return null;
}

async function captureSession(session, prefix) {
  const results = {};
  for (const sid of SECTIONS) {
    const short = shortId(sid);
    const js = `(() => {
  const el = document.getElementById(${JSON.stringify(sid)});
  if (!el) return null;
  el.scrollIntoView({ block: 'start' });
  const r = el.getBoundingClientRect();
  return { id: ${JSON.stringify(sid)}, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;
    abEval(session, js);
    await sleep(350);
    const rect = abEval(session, js);
    const shot = path.join(OUT, `_tmp_${prefix}_${short}.png`);
    const { out } = ab(session, ['screenshot', shot]);
    if (!fs.existsSync(shot)) {
      console.log(prefix, short, 'shot fail', out.slice(0, 200));
      results[sid] = { error: out };
      continue;
    }
    if (!rect || typeof rect !== 'object' || !rect.w) {
      console.log(prefix, short, 'bad rect', typeof rect === 'string' ? rect.slice(0, 200) : rect);
      results[sid] = { error: rect };
      continue;
    }
    results[sid] = { shot, rect };
    console.log(prefix, short, rect);
  }
  return results;
}

function cropWithPython(pairs) {
  const script = `
from pathlib import Path
from PIL import Image
import json, sys
pairs = json.loads(sys.argv[1])
out_metrics = {}
for item in pairs:
    prefix = item['prefix']
    short = item['short']
    shot = Path(item['shot'])
    rect = item['rect']
    if not shot.exists() or not rect:
        continue
    img = Image.open(shot).convert('RGB')
    x,y,w,h = rect['x'], rect['y'], rect['w'], rect['h']
    x=max(0,int(x)); y=max(0,int(y)); w=int(w); h=int(h)
    crop = img.crop((x,y,min(img.width,x+w),min(img.height,y+h)))
    dest = Path(${JSON.stringify(OUT.replace(/\\/g, '/'))}) / f'live3-{prefix}-{short}.png'
    crop.save(dest)
    print(f'CROP {prefix} {short} {crop.size}')
`;
  // Actually do all crops + metrics in one python block
  const payload = [];
  for (const [sessionPrefix, results] of Object.entries(pairs)) {
    for (const [sid, info] of Object.entries(results)) {
      if (!info.shot || !info.rect) continue;
      payload.push({
        prefix: sessionPrefix,
        short: shortId(sid),
        shot: info.shot,
        rect: info.rect,
      });
    }
  }
  const py = `
from pathlib import Path
from PIL import Image
import json, numpy as np
OUT = Path(r${JSON.stringify(OUT)})
payload = json.loads(r'''${JSON.stringify(payload)}''')
for item in payload:
    shot = Path(item['shot'])
    rect = item['rect']
    prefix = item['prefix']
    short = item['short']
    img = Image.open(shot).convert('RGB')
    x,y,w,h = int(rect['x']), int(rect['y']), int(rect['w']), int(rect['h'])
    x=max(0,x); y=max(0,y)
    crop = img.crop((x,y,min(img.width,x+w),min(img.height,y+h)))
    dest = OUT / f'live3-{prefix}-{short}.png'
    crop.save(dest)
    print('CROP', prefix, short, crop.size)

sections = sorted({p['short'] for p in payload})
metrics = {}
for short in sections:
    wa = OUT / f'live3-web-{short}.png'
    ga = OUT / f'live3-gui-{short}.png'
    if not wa.exists() or not ga.exists():
        print('MISS', short, wa.exists(), ga.exists()); continue
    A = np.asarray(Image.open(wa).convert('RGB'), dtype=np.int16)
    B = np.asarray(Image.open(ga).convert('RGB'), dtype=np.int16)
    h,w = min(A.shape[0], B.shape[0]), min(A.shape[1], B.shape[1])
    A,B = A[:h,:w], B[:h,:w]
    d = np.abs(A-B)
    mean = float(d.mean())
    pct = float((d.max(axis=2) > 20).mean() * 100)
    metrics[short] = {
        'mean': round(mean, 3),
        'pct_gt20': round(pct, 3),
        'size': f'{w}x{h}',
        'web': list(Image.open(wa).size),
        'gui': list(Image.open(ga).size),
    }
    print(f'METRIC {short}: mean={mean:.3f} pct_gt20={pct:.2f}% size={w}x{h}')
    heat = np.zeros_like(A)
    heat[:,:,0] = np.clip(d.max(axis=2)*3, 0, 255)
    heat[:,:,1] = np.clip(40 - d.mean(axis=2), 0, 40)
    Image.fromarray(heat.astype(np.uint8)).save(OUT / f'live3-heat-{short}.png')
    pad = 8
    side = Image.new('RGB', (w*2+pad, h), (30,30,30))
    side.paste(Image.fromarray(A.astype(np.uint8)), (0,0))
    side.paste(Image.fromarray(B.astype(np.uint8)), (w+pad,0))
    side.save(OUT / f'live3-side-{short}.png')
(OUT / 'live3-pixel-metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
print('WROTE metrics', len(metrics))
`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, cwd: ROOT });
  console.log(r.stdout || '');
  if (r.stderr) console.error(r.stderr);
  if (r.status !== 0) process.exit(r.status || 1);
}

fs.mkdirSync(OUT, { recursive: true });
console.log('WEB...');
const web = await captureSession('parity-web', 'web');
console.log('GUI...');
const gui = await captureSession('parity-gui', 'gui');
cropWithPython({ web, gui });
