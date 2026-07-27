/**
 * Homomorphic settings-group capture + pixel metrics (WebUI vs GUI).
 *
 * Captures a viewport screenshot, then crops with Math.floor(boundingClientRect)
 * so both sessions share the same integer crop phase (avoids ±1px element-screenshot
 * rounding drift that inflates CJK AA residuals).
 *
 * Requires agent-browser sessions: parity-web, parity-gui.
 *
 *   node scripts/parity-live-capture.mjs [tag]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'parity-evidence');
const TAG = process.argv[2] || 'live8';
const AB = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'agent-browser.cmd')
  : 'agent-browser';

const SECTIONS = [
  ['appearance', 'settings-section-appearance'],
  ['model', 'settings-section-model'],
  ['settings-group-modelAndReasoning', 'settings-section-settings-group-modelAndReasoning'],
  ['settings-group-behavior', 'settings-section-settings-group-behavior'],
  ['settings-group-memory', 'settings-section-settings-group-memory'],
  ['settings-group-language', 'settings-section-settings-group-language'],
  ['settings-group-advanced', 'settings-section-settings-group-advanced'],
  ['settings-group-sandbox', 'settings-section-settings-group-sandbox'],
];

function ab(session, args) {
  const r = spawnSync(
    process.platform === 'win32' ? 'cmd' : AB,
    process.platform === 'win32' ? ['/c', AB, '--session', session, ...args] : ['--session', session, ...args],
    { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, cwd: ROOT },
  );
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

function parseJsonLoose(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  const startA = text.indexOf('[');
  const endA = text.lastIndexOf(']');
  if (startA >= 0 && endA > startA) {
    try {
      return JSON.parse(text.slice(startA, endA + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function prepareSection(session, sectionId) {
  // Windows agent-browser eval rejects multiline expressions — keep single-line.
  const id = JSON.stringify(sectionId);
  const js = `(()=>{const el=document.getElementById(${id});if(!el)return{ok:false,error:"missing"};const root=document.querySelector(".settings-content")||document.scrollingElement||document.documentElement;el.scrollIntoView({block:"start",inline:"nearest"});const targetTop=64;for(let i=0;i<10;i++){const r=el.getBoundingClientRect();const dy=r.top-targetTop;if(Math.abs(dy)<0.2)break;if(root&&root.scrollBy)root.scrollBy(0,dy);else window.scrollBy(0,dy);}for(let i=0;i<8;i++){const r=el.getBoundingClientRect();const frac=r.top-Math.round(r.top);if(Math.abs(frac)<0.02)break;if(root&&root.scrollBy)root.scrollBy(0,frac);else window.scrollBy(0,frac);}document.activeElement&&document.activeElement.blur&&document.activeElement.blur();const r=el.getBoundingClientRect();const dpr=window.devicePixelRatio||1;const x=Math.floor(r.left*dpr),y=Math.floor(r.top*dpr),w=Math.floor(r.right*dpr)-x,h=Math.floor(r.bottom*dpr)-y;return{ok:true,dpr,css:{top:r.top,left:r.left,width:r.width,height:r.height},crop:{x,y,w,h},fracTop:r.top%1};})()`;
  const out = ab(session, ['eval', js]);
  return parseJsonLoose(out) || { ok: false, raw: out.slice(0, 200) };
}

function captureSession(session, prefix) {
  const results = {};
  for (const [short, sectionId] of SECTIONS) {
    const prep = prepareSection(session, sectionId);
    ab(session, ['wait', '80']);
    const fullPath = path.join(OUT, `_${TAG}_${prefix}_vp_${short}.png`);
    ab(session, ['screenshot', fullPath]);
    results[short] = { prep, fullPath };
    console.log(`[${prefix}] ${short}`, JSON.stringify(prep));
  }
  return results;
}

console.log('tag', TAG);
fs.mkdirSync(OUT, { recursive: true });
const web = captureSession('parity-web', 'web');
const gui = captureSession('parity-gui', 'gui');

const metaJson = JSON.stringify({
  web: Object.fromEntries(Object.entries(web).map(([k, v]) => [k, v.prep])),
  gui: Object.fromEntries(Object.entries(gui).map(([k, v]) => [k, v.prep])),
});
const py = `
from PIL import Image
import numpy as np
from pathlib import Path
import json

OUT = Path(${JSON.stringify(OUT.replace(/\\\\/g, '/'))})
TAG = ${JSON.stringify(TAG)}
meta = json.loads(${JSON.stringify(metaJson)})
ids = json.loads(${JSON.stringify(JSON.stringify(SECTIONS.map((s) => s[0])))})
metrics = {}

def crop_vp(path, crop):
    im = Image.open(path).convert('RGB')
    x, y, w, h = crop['x'], crop['y'], crop['w'], crop['h']
    # clamp
    x = max(0, min(x, im.width - 1))
    y = max(0, min(y, im.height - 1))
    w = max(1, min(w, im.width - x))
    h = max(1, min(h, im.height - y))
    return im.crop((x, y, x + w, y + h))

for name in ids:
    wp = OUT / f'_{TAG}_web_vp_{name}.png'
    gp = OUT / f'_{TAG}_gui_vp_{name}.png'
    wc = meta['web'].get(name, {}).get('crop')
    gc = meta['gui'].get(name, {}).get('crop')
    if not wp.exists() or not gp.exists() or not wc or not gc:
        metrics[name] = {'error': 'missing', 'web': meta['web'].get(name), 'gui': meta['gui'].get(name)}
        print(name, 'missing')
        continue
    wim = crop_vp(wp, wc)
    gim = crop_vp(gp, gc)
    # normalize to shared size (min)
    mw = min(wim.width, gim.width)
    mh = min(wim.height, gim.height)
    wim = wim.crop((0, 0, mw, mh))
    gim = gim.crop((0, 0, mw, mh))
    wim.save(OUT / f'{TAG}-web-{name}.png')
    gim.save(OUT / f'{TAG}-gui-{name}.png')
    wa = np.asarray(wim).astype(float)
    ga = np.asarray(gim).astype(float)
    d = np.abs(wa - ga).mean(axis=2)
    mean = float(d.mean())
    pct = float((d > 20).mean() * 100)
    # also report best ±2px vertical shift residual
    best = mean
    bs = 0
    for dy in range(-2, 3):
        if dy == 0:
            continue
        g2 = np.roll(ga, dy, 0)
        m = max(2, abs(dy))
        dd = np.abs(wa[m:-m, :] - g2[m:-m, :]).mean()
        if dd < best:
            best = float(dd)
            bs = dy
    metrics[name] = {
        'mean': round(mean, 3),
        'pct_gt20': round(pct, 3),
        'best_shift_mean': round(best, 3),
        'best_shift_dy': bs,
        'size': f'{mw}x{mh}',
        'web': [wim.width, wim.height],
        'gui': [gim.width, gim.height],
        'web_crop': wc,
        'gui_crop': gc,
    }
    heat = np.zeros((mh, mw, 3), dtype=np.uint8)
    heat[..., 1] = 40
    heat[..., 0] = np.clip(d * 8, 0, 255).astype(np.uint8)
    Image.fromarray(heat).save(OUT / f'{TAG}-heat-{name}.png')
    side = Image.new('RGB', (mw * 2 + 8, mh), (245, 245, 245))
    side.paste(wim, (0, 0))
    side.paste(gim, (mw + 8, 0))
    side.save(OUT / f'{TAG}-side-{name}.png')
    print(f'{name:40s} mean={mean:7.3f} best={best:7.3f}@dy={bs} pct={pct:6.3f} size={mw}x{mh}')

payload = {
    'date': '2026-07-21',
    'tag': TAG,
    'element_level': metrics,
    'notes': [
        'Viewport screenshot + Math.floor device-pixel crop (shared phase)',
        'Integer top snap before capture',
        'scrollbar-width thin; env textarea 172px',
    ],
}
(OUT / f'{TAG}-pixel-metrics.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
print('wrote', OUT / f'{TAG}-pixel-metrics.json')
`;

const pyPath = path.join(OUT, `_${TAG}_metrics.py`);
fs.writeFileSync(pyPath, py, 'utf8');
const pr = spawnSync('python', [pyPath], { encoding: 'utf8', cwd: ROOT });
// L11: clean up the temp python script (previously left behind, one stray .py per invocation).
try { fs.unlinkSync(pyPath); } catch { /* already gone */ }
process.stdout.write(pr.stdout || '');
if (pr.stderr) process.stderr.write(pr.stderr);
process.exit(pr.status || 0);
