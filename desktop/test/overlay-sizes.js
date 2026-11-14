// Renders the real arrival overlay at projector and monitor sizes and checks, pixel
// by pixel, that the photo lands in the middle of the screen at the right size and
// that nothing is left behind afterwards. Then it plays the arrival again with reduced
// movement and checks that the photo stays put and no effect is drawn.
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

// The same for a photo that is fading in or out: where is everything at least a quarter
// opaque (the photo, not its soft shadow), and is anything at all drawn in the lowest fifth?
const MEASURE_CALM = `(() => {
  const c = document.getElementById('c');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, foot = 0;
  const low = Math.floor(c.height * 0.8);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const a = d[(y * c.width + x) * 4 + 3];
    if (a > 0 && y >= low) foot++;
    if (a >= 64) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { foot, x0, y0, x1, y1 };
})()`;

app.whenReady().then(async () => {
  const [size, scaleText] = CASE.split('@');
  const [pw, ph] = size.split('x').map(Number);
  const scale = Number(scaleText);
  const W = Math.round(pw / scale), H = Math.round(ph / scale);

  // A real but invisible window: animation frames only run in a window that is shown.
  const win = new BrowserWindow({
    width: 400, height: 300, show: false, frame: false, transparent: true, opacity: 0, skipTaskbar: true, focusable: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'overlay.html'));
  // The emulated screen has to be set after the page loads; setting it earlier crashes Electron 33.
  win.webContents.enableDeviceEmulation({
    screenPosition: 'desktop', screenSize: { width: W, height: H }, viewPosition: { x: 0, y: 0 },
    viewSize: { width: W, height: H }, deviceScaleFactor: scale, scale: 1,
  });
  win.showInactive();
  await new Promise((r) => setTimeout(r, 400));
  let idle = false;
  ipcMain.on('overlay-idle', () => { idle = true; });

  const errors = [];
  const check = (ok, text) => { if (!ok) errors.push(text); };
  const started = Date.now();
  const at = (ms) => new Promise((r) => setTimeout(r, Math.max(0, started + ms - Date.now())));
  win.webContents.send('arrive', { url: null, name: 'Preview', from: 'Pixel 8', x: 0.8, effect: 'ripple', sound: false });

  await at(1800); // resting in the middle
  const b = await win.webContents.executeJavaScript(MEASURE);
  const k = b.cw / W; // canvas pixels per logical pixel
  check(b.iw === W && b.ih === H, `page is ${b.iw}x${b.ih}, expected ${W}x${H}`);
  check(Math.abs(b.dpr - scale) < 0.01, `device pixel ratio is ${b.dpr}, expected ${scale}`);
  check(Math.abs(b.cw - pw) <= 2 && Math.abs(b.ch - ph) <= 2, `canvas is ${b.cw}x${b.ch}, expected ${pw}x${ph}`);
  check(b.x1 >= 0, 'no photo on screen while resting');
  if (b.x1 >= 0) {
    const cx = (b.x0 + b.x1) / 2 / k, cy = (b.y0 + b.y1) / 2 / k;
    const bw = (b.x1 - b.x0) / k, bh = (b.y1 - b.y0) / k;
    const side = Math.min(W, H) * 0.42; // the preview picture is 4:3, so its width is the long side
    check(Math.abs(cx - W / 2) < W * 0.015, `photo centre x ${cx.toFixed(0)} is not the middle (${W / 2})`);
    check(Math.abs(cy - H * 0.44) < H * 0.03, `photo centre y ${cy.toFixed(0)} is not at 44% (${(H * 0.44).toFixed(0)})`);
    check(bw > side && bw < side * 1.3, `photo width ${bw.toFixed(0)} is not about ${side.toFixed(0)}`);
    check(bh > side * 0.75 && bh < side * 0.75 * 1.4, `photo height ${bh.toFixed(0)} is not about ${(side * 0.75).toFixed(0)}`);
    check(b.x0 > 0 && b.y0 > 0 && b.x1 < b.cw - 1 && b.y1 < b.ch - 1, 'photo touches the screen edge');
  }
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    const png = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");
    fs.writeFileSync(path.join(OUT, `rest-${size}@${scaleText}.png`), nativeImage.createFromDataURL(png).resize({ width: Math.min(960, pw) }).toPNG());
  }

  await at(4400); // flight over (3.25 s) and every ring faded
  const after = await win.webContents.executeJavaScript(MEASURE);
  check(after.any === 0, `${after.any} pixels left on screen after the arrival`);
  check(idle, 'overlay never reported that it was finished');

  // ---------- the same arrival with reduced movement ----------
  // The photo must be in its resting place from the first moment (it fades in, it does not
  // fly), and the effect must not be drawn at all. Aurora is used because it fills the foot
  // of the screen for the whole flight, so its absence is easy to see.
  idle = false;
  const calmStart = Date.now();
  const calmAt = (ms) => new Promise((r) => setTimeout(r, Math.max(0, calmStart + ms - Date.now())));
  win.webContents.send('arrive', { url: null, name: 'Preview', from: 'Pixel 8', x: 0.8, effect: 'aurora', sound: false, motion: 'reduce' });
  const middle = (m, what) => {
    check(m.x1 >= 0, `calm: no photo on screen ${what}`);
    if (m.x1 < 0) return;
    const cx = (m.x0 + m.x1) / 2 / k, cy = (m.y0 + m.y1) / 2 / k, bw = (m.x1 - m.x0) / k;
    const side = Math.min(W, H) * 0.42;
    check(Math.abs(cx - W / 2) < W * 0.015 && Math.abs(cy - H * 0.44) < H * 0.03, `calm: photo is at ${cx.toFixed(0)},${cy.toFixed(0)} ${what}, not in its resting place`);
    check(bw > side && bw < side * 1.3, `calm: photo is ${bw.toFixed(0)} wide ${what}, not its resting size ${side.toFixed(0)}`);
  };
  await calmAt(170); // a flying photo would still be small and near the foot of the screen
  const early = await win.webContents.executeJavaScript(MEASURE_CALM);
  middle(early, 'as it appears');
  check(early.foot === 0, `calm: ${early.foot} pixels drawn at the foot of the screen as it appears`);
  await calmAt(1800);
  const still = await win.webContents.executeJavaScript(MEASURE_CALM);
  middle(still, 'while resting');
  check(still.foot === 0, `calm: ${still.foot} pixels of the effect drawn at the foot of the screen`);
  if (OUT) {
    const png = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");
    fs.writeFileSync(path.join(OUT, `calm-${size}@${scaleText}.png`), nativeImage.createFromDataURL(png).resize({ width: Math.min(960, pw) }).toPNG());
  }
  await calmAt(4400);
  const gone = await win.webContents.executeJavaScript(MEASURE);
  check(gone.any === 0, `calm: ${gone.any} pixels left on screen after the arrival`);
  check(idle, 'calm: overlay never reported that it was finished');

  const label = `${size} at ${Math.round(scale * 100)}%`.padEnd(22) + `logical ${W}x${H}`;
  if (errors.length) console.log(`FAIL  ${label}\n      ${errors.join('\n      ')}`);
  else console.log(`ok    ${label}`);
  app.exit(errors.length ? 1 : 0);
});
