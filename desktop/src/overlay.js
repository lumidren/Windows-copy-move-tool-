// Arrival animation. A photo enters from the bottom edge (where the phone is),
// flies to the middle of the screen, rests, then tucks into the top-right corner.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1;
// Everything is sized as a share of the screen, so the arrival looks the same on a
// laptop panel, a 1080p projector and a 4K wall. S is 1 on an 864-point-high screen.
let S = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  S = Math.max(0.6, Math.min(W, H) / 864);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const FLY = 900, REST = 1700, TUCK = 650;
const TOTAL = FLY + REST + TUCK;
const PALETTE = ['#6c8cff', '#9b6bff', '#ff6bb5', '#ffb84d', '#4de1c1'];
const FONT = '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeInCubic = (t) => t * t * t;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

let flights = [];
let particles = [];
let rings = [];
const pills = new Map(); // transfer id -> progress pill
let running = false;
let lastFrame = 0;
let stats = null; // frame timing for the current burst of activity

function placeholderImage() {
  const c = document.createElement('canvas');
  c.width = 960; c.height = 720;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 480, 360);
  grad.addColorStop(0, '#6c8cff'); grad.addColorStop(1, '#ff6bb5');
  g.fillStyle = grad; g.fillRect(0, 0, 480, 360);
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.scale(2, 2);
  g.beginPath(); g.arc(360, 110, 38, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(0, 360); g.lineTo(150, 170); g.lineTo(250, 290); g.lineTo(320, 220); g.lineTo(480, 360); g.fill();
  return c;
}

function fileCard(name) {
  const c = document.createElement('canvas');
  c.width = 840; c.height = 840;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1f2b'; g.fillRect(0, 0, 420, 420);
  g.fillStyle = '#6c8cff';
  g.beginPath(); g.moveTo(140, 80); g.lineTo(240, 80); g.lineTo(290, 130); g.lineTo(290, 280); g.lineTo(140, 280); g.closePath(); g.fill();
  g.fillStyle = '#a9b9ff';
  g.scale(2, 2);
  g.beginPath(); g.moveTo(240, 80); g.lineTo(240, 130); g.lineTo(290, 130); g.closePath(); g.fill();
  g.fillStyle = '#fff'; g.font = '600 24px "Segoe UI", sans-serif'; g.textAlign = 'center';
  const label = name.length > 26 ? name.slice(0, 23) + '…' : name;
  g.fillText(label, 210, 345);
  return c;
}

function addFlight(item, img) {
  const maxSide = Math.min(W, H) * 0.42;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(maxSide / iw, maxSide / ih);
  const w = iw * s, h = ih * s;
  flights.push({
    sprite: makeSprite(img, w, h, item.effect), w, h,
    effect: item.effect, from: item.from, name: item.name, sound: !!item.sound,
    startX: lerp(W * 0.2, W * 0.8, item.x ?? 0.5),
    tilt: rand(-0.09, 0.09),
    t0: 0, warm: 0, landed: false, lastTrail: 0,
    hue: Math.floor(rand(0, PALETTE.length)),
  });
  kick();
}

function spawnRings(x, y, n) {
  for (let i = 0; i < n; i++) rings.push({ x, y, born: performance.now() + i * 140, life: 1300, max: Math.max(W, H) * 0.45 });
}

function spawnConfetti(x, y) {
  for (let i = 0; i < 110; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(3, 13);
    particles.push({
      kind: 'confetti', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4,
      rot: rand(0, 6), vr: rand(-0.3, 0.3), size: rand(6, 12),
      color: PALETTE[i % PALETTE.length], born: performance.now(), life: rand(900, 1700),
    });
  }
}

function pose(f, now) {
  const e = now - f.t0;
  const cx = W / 2, cy = H * 0.44;
  if (e < FLY) {
    const t = e / FLY;
    return {
      x: lerp(f.startX, cx, easeOutCubic(t)),
      y: lerp(H + f.h * 0.6, cy, easeOutBack(t)),
      scale: lerp(0.35, 1, easeOutCubic(t)), rot: lerp(f.tilt * 4, f.tilt, easeOutCubic(t)), alpha: 1, phase: 'fly', t,
    };
  }
  if (e < FLY + REST) {
    const t = (e - FLY) / REST;
    return { x: cx, y: cy + Math.sin(t * Math.PI * 2) * 4 * S, scale: 1, rot: f.tilt, alpha: 1, phase: 'rest', t };
  }
  const t = Math.min(1, (e - FLY - REST) / TUCK);
  const k = easeInCubic(t);
  return {
    x: lerp(cx, W - 70 * S, k), y: lerp(cy, 70 * S, k),
    scale: lerp(1, 0.08, k), rot: lerp(f.tilt, 0.5, k), alpha: 1 - k * k, phase: 'tuck', t,
  };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawAurora(f, p) {
  const strength = p.phase === 'fly' ? p.t : p.phase === 'rest' ? 1 : 1 - p.t;
  const time = (performance.now() - f.t0) / 1000;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const baseY = H - (40 + i * 60) * S;
    const grad = ctx.createLinearGradient(0, baseY - 260 * S, 0, baseY + 60 * S);
    const color = PALETTE[(i + f.hue) % PALETTE.length];
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.6, color + '55');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.55 * strength;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W + 40 * S; x += 40 * S) {
      const y = baseY - 150 * S * strength + Math.sin(x / (260 * S) + time * 1.4 + i * 1.7) * 60 * S;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawFlight(f, now) {
  const p = pose(f, now);
  if (f.effect === 'aurora') drawAurora(f, p);

  if (f.effect === 'comet' && p.phase === 'fly' && now - f.lastTrail > 12) {
    f.lastTrail = now;
    for (let i = 0; i < 5; i++) {
      particles.push({
        kind: 'spark', x: p.x + rand(-f.w, f.w) * 0.3 * p.scale, y: p.y + f.h * 0.4 * p.scale,
        vx: rand(-1.2, 1.2), vy: rand(1, 5), size: rand(3, 9),
        color: PALETTE[Math.floor(rand(0, PALETTE.length))], born: now, life: rand(450, 900),
      });
    }
  }

  if (!f.landed && p.phase !== 'fly') {
    f.landed = true;
    if (f.effect === 'confetti') spawnConfetti(p.x, p.y);
    if (f.effect === 'ripple') spawnRings(p.x, p.y, 3);
  }

  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(p.scale, p.scale);
  const { canvas: sprite, m } = f.sprite;
  ctx.drawImage(sprite, -f.w / 2 - m, -f.h / 2 - m, f.w + m * 2, f.h + m * 2);

  // caption pill while resting
  if (p.phase === 'rest') {
    const a = Math.min(1, p.t * 6) * Math.min(1, (1 - p.t) * 6);
    const text = `From ${f.from}`;
    ctx.font = `600 ${15 * S}px ${FONT}`;
    const tw = ctx.measureText(text).width;
    ctx.globalAlpha = a * p.alpha;
    ctx.fillStyle = 'rgba(14,16,22,.82)';
    roundRect(-tw / 2 - 14 * S, f.h / 2 + 26 * S, tw + 28 * S, 32 * S, 16 * S);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, f.h / 2 + 42 * S);
  }
  ctx.restore();
}

// k is the frame length relative to a 60 Hz frame, so particles move at the same
// speed on a 60 Hz projector and a 144 Hz laptop panel.
function drawParticles(now, k) {
  particles = particles.filter((q) => now - q.born < q.life);
  for (const q of particles) {
    const t = (now - q.born) / q.life;
    q.x += q.vx * k * S; q.y += q.vy * k * S;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = q.color;
    if (q.kind === 'confetti') {
      q.vy += 0.32 * k; q.vx *= Math.pow(0.985, k); q.rot += q.vr * k;
      ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.fillRect(-q.size * S / 2, -q.size * S / 4, q.size * S, q.size * S / 2);
    } else {
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = q.color; ctx.shadowBlur = 14 * S * dpr;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.size * S * (1 - t * 0.7), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

function drawRings(now) {
  rings = rings.filter((r) => now - r.born < r.life);
  for (const r of rings) {
    if (now < r.born) continue;
    const t = (now - r.born) / r.life;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.8;
    ctx.strokeStyle = '#8fb4ff';
    ctx.lineWidth = (5 * (1 - t) + 1) * S;
    ctx.shadowColor = '#6c8cff'; ctx.shadowBlur = 18 * S * dpr;
    ctx.beginPath(); ctx.arc(r.x, r.y, easeOutCubic(t) * r.max, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function frame(now) {
  ctx.clearRect(0, 0, W, H);
  const dt = lastFrame ? Math.min(50, now - lastFrame) : 16.667;
  if (lastFrame && ++stats.seen > 3) { stats.frames++; stats.total += now - lastFrame; stats.worst = Math.max(stats.worst, now - lastFrame); }
  lastFrame = now;
  flights = flights.filter((f) => !f.t0 || now - f.t0 < TOTAL);
  drawRings(now);
  for (const f of flights) {
    if (!f.t0) { if (++f.warm < 3) continue; launch(f, now); }
    drawFlight(f, now);
  }
  drawParticles(now, dt / 16.667);
  drawPills(now);
  if (flights.length || particles.length || rings.length || pills.size) {
    requestAnimationFrame(frame);
  } else {
    running = false;
    ctx.clearRect(0, 0, W, H);
    window.flingo.overlayIdle();
  }
}

window.flingo.onArrive((item) => {
  if (!item.url) {
    addFlight(item, item.name === 'Preview' ? placeholderImage() : fileCard(item.name));
    return;
  }
  const img = new Image();
  img.onload = () => addFlight(item, img);
  img.onerror = () => addFlight(item, fileCard(item.name));
  img.src = item.url;
});

window.flingo.onProgress((p) => {
  const pill = pills.get(p.id);
  if (p.done) {
    if (pill) { pill.doneAt = performance.now(); pill.ok = p.ok; }
    return;
  }
  if (pill) { pill.received = p.received; pill.total = p.total; }
  else pills.set(p.id, { name: p.name, from: p.from, received: p.received, total: p.total, shown: 0, born: performance.now(), doneAt: 0, ok: null });
  kick();
});
