// Renders the real arrival overlay at projector and monitor sizes and checks, pixel
// by pixel, that the photo lands in the middle of the screen at the right size and
// that nothing is left behind afterwards.
//
//   npm run test:overlay                       every size below
//   electron test/overlay-sizes.js --case=3840x2160@1.5 [--out=folder]
//
// Each size runs in its own Electron process with the screen emulated, so the test
// does not depend on the monitor this machine happens to have. The windows are
// invisible; nothing appears on screen while it runs.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const CASE = arg('case');
const OUT = arg('out');

// physical resolution @ display scaling
const CASES = [
  '1920x1080@1', '1920x1080@1.25', '1920x1080@1.5',
  '3840x2160@1', '3840x2160@1.5', '3840x2160@2',
  '1280x720@1', '1024x768@1', '2560x1080@1', '1080x1920@1',
];

if (!CASE) {
  let failed = 0;
  for (const c of CASES) {
    const r = spawnSync(process.execPath, [__filename, `--case=${c}`, ...(OUT ? [`--out=${OUT}`] : [])], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `${failed} of ${CASES.length} sizes failed` : `all ${CASES.length} sizes ok`);
  process.exit(failed ? 1 : 0);
}

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

// Runs inside the page: where are the fully opaque pixels (the framed photo)?
const MEASURE = `(() => {
  const c = document.getElementById('c');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, any = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const a = d[(y * c.width + x) * 4 + 3];
    if (a > 0) any++;
    if (a >= 250) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { cw: c.width, ch: c.height, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, any, x0, y0, x1, y1 };
})()`;
