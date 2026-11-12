// Arrival animation. A photo enters from the bottom edge (where the phone is),
// flies to the middle of the screen, rests, then tucks into the top-right corner.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const FLY = 900, REST = 1700, TUCK = 650;
const TOTAL = FLY + REST + TUCK;
const PALETTE = ['#6c8cff', '#9b6bff', '#ff6bb5', '#ffb84d', '#4de1c1'];

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeInCubic = (t) => t * t * t;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

let flights = [];
let particles = [];
let rings = [];
let running = false;

function addFlight(item, img) {
  const maxSide = Math.min(W, H) * 0.42;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(maxSide / iw, maxSide / ih);
  flights.push({
    img, w: iw * s, h: ih * s,
    effect: item.effect, from: item.from, name: item.name,
    startX: lerp(W * 0.2, W * 0.8, item.x ?? 0.5),
    tilt: rand(-0.09, 0.09),
    t0: performance.now(), landed: false, lastTrail: 0,
    hue: Math.floor(rand(0, PALETTE.length)),
  });
  if (!running) { running = true; requestAnimationFrame(frame); }
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
    return { x: cx, y: cy + Math.sin(t * Math.PI * 2) * 4, scale: 1, rot: f.tilt, alpha: 1, phase: 'rest', t };
  }
  const t = Math.min(1, (e - FLY - REST) / TUCK);
  const k = easeInCubic(t);
  return {
    x: lerp(cx, W - 70, k), y: lerp(cy, 70, k),
    scale: lerp(1, 0.08, k), rot: lerp(f.tilt, 0.5, k), alpha: 1 - k * k, phase: 'tuck', t,
  };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawFlight(f, now) {
  const p = pose(f, now);

  if (!f.landed && p.phase !== 'fly') {
    f.landed = true;
  }

  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(p.scale, p.scale);

  // glow + white photo frame
  const pad = 10;
  ctx.shadowColor = f.effect === 'comet' ? 'rgba(108,140,255,.9)' : 'rgba(0,0,0,.55)';
  ctx.shadowBlur = f.effect === 'comet' ? 60 : 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#fff';
  roundRect(-f.w / 2 - pad, -f.h / 2 - pad, f.w + pad * 2, f.h + pad * 2, 18);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  roundRect(-f.w / 2, -f.h / 2, f.w, f.h, 10);
  ctx.clip();
  ctx.drawImage(f.img, -f.w / 2, -f.h / 2, f.w, f.h);
  ctx.restore();

  ctx.restore();
}

function drawParticles(now) {
  particles = particles.filter((q) => now - q.born < q.life);
  for (const q of particles) {
    const t = (now - q.born) / q.life;
    q.x += q.vx; q.y += q.vy;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = q.color;
    if (q.kind === 'confetti') {
      q.vy += 0.32; q.vx *= 0.985; q.rot += q.vr;
      ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      ctx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2);
    } else {
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = q.color; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.size * (1 - t * 0.7), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

function frame(now) {
  ctx.clearRect(0, 0, W, H);
  flights = flights.filter((f) => now - f.t0 < TOTAL);
  for (const f of flights) drawFlight(f, now);
  drawParticles(now);
  if (flights.length || particles.length || rings.length) {
    requestAnimationFrame(frame);
  } else {
    running = false;
    ctx.clearRect(0, 0, W, H);
    window.flingo.overlayIdle();
  }
}

window.flingo.onArrive((item) => {
  const img = new Image();
  img.onload = () => addFlight(item, img);
  img.src = item.url;
});
