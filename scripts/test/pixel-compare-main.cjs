// 像素三方 diff 的比较核心（在 Electron 里跑：nativeImage 解码 PNG 无需新依赖）。
// 用法：electron pixel-compare-main.cjs <app.png> <baseline.png> <proto.png> <out.json>
// 报告：逐对 diff 的差异像素数、差异簇包围盒、判定与理由槽位。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

// 每通道容差（0-255）：≤12 视为同一像素（≈5%，对应亚像素反锯齿抖动）。
const CHANNEL_TOLERANCE = 12;
// 差异像素占比超过该值判 FAIL（1px 级几何差异 ≈0.1% 以下）。
const MAX_DIFF_RATIO = 0.01;
// 对比前统一缩放到该宽度（CSS 像素）：app 截图按 devicePixelRatio 放大、
// 原型 capturePage 按窗口缩放比例，不同 DPR 不能直接逐像素对比。
const TARGET_WIDTH = 320;

function bitmapOf(pngPath) {
  const image = nativeImage.createFromPath(pngPath);
  if (image.isEmpty()) throw new Error(`cannot decode PNG: ${pngPath}`);
  const size = image.getSize();
  let resized = image;
  if (size.width !== TARGET_WIDTH) {
    resized = image.resize({ width: TARGET_WIDTH, quality: 'good' });
  }
  const rs = resized.getSize();
  const buffer = resized.toBitmap(); // BGRA
  return { width: rs.width, height: rs.height, buffer };
}

function pixelAt(bmp, x, y) {
  const offset = (y * bmp.width + x) * 4;
  return [
    bmp.buffer[offset + 2], // R
    bmp.buffer[offset + 1], // G
    bmp.buffer[offset],     // B
    bmp.buffer[offset + 3], // A
  ];
}

function comparePair(label, aPath, bPath) {
  const a = bitmapOf(aPath);
  const b = bitmapOf(bPath);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let differing = 0;
  let total = width * height;
  let maxDelta = 0;
  const clusters = [];
  let currentCluster = null;
  const yHist = new Array(Math.ceil(height / 20)).fill(0);
  const xHist = new Array(Math.ceil(width / 20)).fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pa = pixelAt(a, x, y);
      const pb = pixelAt(b, x, y);
      const delta = Math.max(
        Math.abs(pa[0] - pb[0]),
        Math.abs(pa[1] - pb[1]),
        Math.abs(pa[2] - pb[2]),
        Math.abs(pa[3] - pb[3]),
      );
      maxDelta = Math.max(maxDelta, delta);
      if (delta > CHANNEL_TOLERANCE) {
        differing += 1;
        yHist[Math.floor(y / 20)] += 1;
        xHist[Math.floor(x / 20)] += 1;
        if (!currentCluster) {
          currentCluster = { x0: x, y0: y, x1: x, y1: y, count: 0 };
          clusters.push(currentCluster);
        }
        currentCluster.x1 = x;
        currentCluster.y1 = y;
        currentCluster.count += 1;
      } else if (currentCluster && x - currentCluster.x1 > 24) {
        currentCluster = null; // 间隔超过 24px 视为新簇
      }
    }
    if (currentCluster && y - currentCluster.y1 > 24) currentCluster = null;
  }

  const ratio = total ? differing / total : 1;
  return {
    label,
    a: aPath,
    b: bPath,
    sizeA: `${a.width}x${a.height}`,
    sizeB: `${b.width}x${b.height}`,
    compared: `${width}x${height}`,
    differingPixels: differing,
    totalPixels: total,
    diffRatio: Number(ratio.toFixed(5)),
    maxChannelDelta: maxDelta,
    clusters: clusters.slice(0, 12).map((c) => ({
      box: `x${c.x0}-${c.x1} y${c.y0}-${c.y1}`,
      pixels: c.count,
    })),
    yHist: yHist.map((count, i) => ({ band: i * 20, count })),
    xHist: xHist.map((count, i) => ({ band: i * 20, count })),
    pass: ratio <= MAX_DIFF_RATIO,
    reason: '',
  };
}

const [pngApp, pngBaseline, pngProto, outJson] = process.argv.slice(2);
if (!pngApp || !pngBaseline || !pngProto || !outJson) {
  console.error('usage: electron pixel-compare-main.cjs <app.png> <baseline.png> <proto.png> <out.json>');
  app.exit(2);
}

const report = {
  tolerance: { channel: CHANNEL_TOLERANCE, maxDiffRatio: MAX_DIFF_RATIO },
  pairs: [
    comparePair('app-vs-baseline', pngApp, pngBaseline),
    comparePair('app-vs-prototype', pngApp, pngProto),
  ],
};
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
app.exit(0);
