'use strict';

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');
const DPR    = Math.min(window.devicePixelRatio || 1, 2);
const W = 900, H = 600;
canvas.width  = W * DPR;
canvas.height = H * DPR;
ctx.scale(DPR, DPR);

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  WIN:          5,
  COOK_SEC:     15,   // cuisson réduite à 15s
  REMOVE_SEC:   10,
  BOIL_WIN_SEC: 18,
  GAUGE_PERIOD: 1,
  G_MIN: 0.70,
  G_MAX: 0.90,
  XH_SPD: 320,
  WARMUP_MIN:   4,
  WARMUP_MAX:   13,
  COOLDOWN_MIN: 6,
  COOLDOWN_MAX: 16,
};

// ── Pot layout ────────────────────────────────────────────────────────────────
const POT_DEFS = [
  { id: 0, bx: 302, by: 292, s: 0.70 },
  { id: 1, bx: 598, by: 292, s: 0.70 },
  { id: 2, bx: 236, by: 432, s: 1.00 },
  { id: 3, bx: 664, by: 432, s: 1.00 },
];
const BASE = { rx: 68, ry: 21, h: 72 };

// ── Runtime state ─────────────────────────────────────────────────────────────
let phase  = 'welcome';
let score  = 0;
let gDir   = 1;
let gPhase = 0;
let gVal   = 0;
let xh     = { x: W / 2, y: H * 0.62 };
let pots   = [];
let projs  = [];
let steams = [];
let tongs  = [];
let explos = [];
let keys   = {};
let spaceLocked = false;
let lastT  = 0;
let joyTouch = null;
const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// ── Audio ─────────────────────────────────────────────────────────────────────
const bgMusic = new Audio('assets/italie.mp3');
bgMusic.loop = true; bgMusic.volume = 0.45;
let musicStarted = false;
function tryStartMusic() {
  if (!musicStarted) { bgMusic.play().catch(() => {}); musicStarted = true; }
}

const sndThrow = new Audio('assets/throw.mp3');
sndThrow.volume = 0.8;
function playThrow() { sndThrow.currentTime = 0; sndThrow.play().catch(() => {}); }

const sndMort = new Audio('assets/mort.mp3');
sndMort.volume = 0.85;
function playMort() { sndMort.currentTime = 0; sndMort.play().catch(() => {}); }

// ── Images ────────────────────────────────────────────────────────────────────
const imgHomard = new Image();
const imgSalut  = new Image();
imgHomard.src = 'assets/homard.png';
imgSalut.src  = 'assets/salut.png';
let imgsReady = 0;
imgHomard.onload = imgSalut.onload = () => imgsReady++;

// ── Helpers ───────────────────────────────────────────────────────────────────
const rnd   = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const smoothstep = t => t * t * (3 - 2 * t);

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// ── Pot class ─────────────────────────────────────────────────────────────────
class Pot {
  constructor(d) {
    this.id = d.id; this.bx = d.bx; this.by = d.by; this.s = d.s;
    this.rx = BASE.rx * d.s;
    this.ry = BASE.ry * d.s;
    this.h  = BASE.h  * d.s;

    this.state      = 'idle';
    this.stateT     = 0;
    this.nextBoil   = rnd(CFG.WARMUP_MIN, CFG.WARMUP_MAX);
    this.wobble     = 0;
    this.flashGood  = 0;
    this.flashBad   = 0;
    this.explodingT = 0;  // counts down while exploding (pot hidden)

    this.boilSound = new Audio('assets/eau.mp3');
    this.boilSound.loop = true; this.boilSound.volume = 0.45;
  }
  get topY() { return this.by - this.h; }
  get px()   { return this.bx + this.wobble; }

  hit(px, py) {
    const dx = (px - this.bx) / (this.rx * 1.5);
    const dy = (py - (this.by - this.h * 0.5)) / (this.h * 0.9);
    return dx * dx + dy * dy < 1;
  }

  startBoil() {
    this.boilSound.currentTime = 0;
    this.boilSound.play().catch(() => {});
  }
  stopBoil() {
    this.boilSound.pause();
    this.boilSound.currentTime = 0;
  }
}

// ── Projectile ────────────────────────────────────────────────────────────────
class Proj {
  constructor(pot) {
    this.pot = pot; this.t = 0; this.ang = 0; this.done = false;
  }
  get x() { return lerp(W / 2, this.pot.bx, smoothstep(this.t)); }
  get y() {
    return lerp(H + 50, this.pot.topY + 6, smoothstep(this.t))
           - 240 * this.pot.s * Math.sin(Math.PI * this.t);
  }
  get sz() { return lerp(130, 65 * this.pot.s, this.t); }
}

// ── Tongs ─────────────────────────────────────────────────────────────────────
class Tongs {
  constructor(pot) {
    this.pot  = pot;
    this.t    = 0;
    this.done = false;
  }
  // Phases: 0..0.35 descend | 0.35..0.55 grab | 0.55..1.5 lift
  update(dt) {
    this.t = Math.min(1.5, this.t + dt);
    if (this.t >= 1.5) this.done = true;
  }
  get openAngle() {
    if (this.t < 0.35) return 0.54;
    if (this.t < 0.55) return lerp(0.54, 0.04, (this.t - 0.35) / 0.20);
    return 0.04;
  }
  get tipY() {
    const top = this.pot.topY;
    if (this.t < 0.35) return lerp(-80, top, smoothstep(this.t / 0.35));
    if (this.t < 0.55) return top;
    return lerp(top, -130, smoothstep((this.t - 0.55) / 0.95));
  }
  get isLifting()     { return this.t >= 0.55; }
  get liftProgress()  { return clamp((this.t - 0.55) / 0.95, 0, 1); }
}

// ── Explosion ─────────────────────────────────────────────────────────────────
class Explosion {
  constructor(pot) {
    this.x = pot.bx; this.y = pot.by - pot.h * 0.5; this.s = pot.s;
    this.t  = 0; this.done = false;
    this.particles = [];

    // Fire particles
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + rnd(0, 0.28);
      const spd = rnd(90, 230) * pot.s;
      this.particles.push({
        x: pot.bx, y: pot.topY + pot.h * 0.3,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - rnd(30, 80),
        r: rnd(5, 13) * pot.s,
        color: ['#ff4400','#ff7700','#ffcc00','#ff2200','#ff8800'][i % 5],
        rot: rnd(0, Math.PI * 2), rotV: rnd(-6, 6),
        type: 'fire',
      });
    }
    // Lobster pieces (3 lobster icons spinning)
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rnd(0, 0.5);
      const spd = rnd(110, 180) * pot.s;
      this.particles.push({
        x: pot.bx, y: pot.topY,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - rnd(60, 120),
        r: pot.rx * 0.55,
        color: '', rot: rnd(0, Math.PI * 2), rotV: rnd(-8, 8),
        type: 'lobster',
      });
    }
    // Pot shards
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rnd(0, 0.4);
      const spd = rnd(60, 140) * pot.s;
      this.particles.push({
        x: pot.bx + rnd(-pot.rx, pot.rx) * 0.5,
        y: pot.by - rnd(0, pot.h),
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - rnd(20, 60),
        r: rnd(6, 14) * pot.s,
        color: '#555', rot: rnd(0, Math.PI * 2), rotV: rnd(-10, 10),
        type: 'shard',
      });
    }
  }
  update(dt) {
    this.t += dt;
    if (this.t > 1.6) { this.done = true; return; }
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 380 * dt;  // gravity
      p.rot += p.rotV * dt;
    }
  }
}

// ── Steam ─────────────────────────────────────────────────────────────────────
class Steam {
  constructor(x, y, s) {
    this.x = x + rnd(-12, 12) * s; this.y = y;
    this.vx = rnd(-14, 14) * s; this.vy = rnd(-65, -105) * s;
    this.r = rnd(4, 9) * s; this.a = 1; this.da = rnd(0.5, 0.9);
  }
  update(dt) {
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.a = Math.max(0, this.a - this.da * dt);
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (phase === 'welcome') { startGame(); return; }
    if (phase === 'playing' && !spaceLocked) { doAction(); spaceLocked = true; }
  }
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space' || e.code === 'Enter') spaceLocked = false;
});

canvas.addEventListener('click', () => { if (phase === 'welcome') startGame(); });

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = toCanvas(t);
    if (phase === 'welcome') { startGame(); return; }
    if (phase !== 'playing') return;
    if (p.x > W * 0.62) doAction();
    else joyTouch = { id: t.identifier, ox: p.x, oy: p.y, dx: 0, dy: 0 };
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joyTouch && t.identifier === joyTouch.id) {
      const p = toCanvas(t);
      joyTouch.dx = clamp((p.x - joyTouch.ox) / 72, -1, 1);
      joyTouch.dy = clamp((p.y - joyTouch.oy) / 72, -1, 1);
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joyTouch && t.identifier === joyTouch.id) joyTouch = null;
  }
}, { passive: false });

const fireBtn = document.getElementById('fire-btn');
if (fireBtn) {
  fireBtn.addEventListener('touchstart', e => {
    e.preventDefault(); e.stopPropagation();
    if (phase === 'playing') doAction();
  }, { passive: false });
}

function toCanvas(touch) {
  const r = canvas.getBoundingClientRect();
  return { x: (touch.clientX - r.left) / r.width * W, y: (touch.clientY - r.top) / r.height * H };
}

// ── Game logic ────────────────────────────────────────────────────────────────
function startGame() {
  pots.forEach(p => p.stopBoil());
  score = 0; gPhase = 0; gDir = 1; gVal = 0;
  xh = { x: W / 2, y: H * 0.62 };
  pots = POT_DEFS.map(d => new Pot(d));
  projs = []; steams = []; tongs = []; explos = [];
  spaceLocked = false;
  phase = 'playing';
  if (fireBtn && isTouchDevice) fireBtn.style.display = 'flex';
  tryStartMusic();
}

function doAction() {
  const target = pots.find(p => p.hit(xh.x, xh.y));
  if (!target) return;

  if (target.state === 'boiling') {
    if (gVal >= CFG.G_MIN && gVal <= CFG.G_MAX) {
      target.state = 'flying'; target.stateT = 0;
      target.stopBoil();
      target.flashGood = 0.8;
      playThrow();
      projs.push(new Proj(target));
    } else {
      target.flashBad = 0.8;
    }
  } else if (target.state === 'ready') {
    // Success: spawn tongs animation
    target.state = 'idle'; target.stateT = 0;
    target.nextBoil = rnd(CFG.COOLDOWN_MIN, CFG.COOLDOWN_MAX);
    target.wobble = 0;
    tongs.push(new Tongs(target));
    score++;
    if (score >= CFG.WIN) {
      setTimeout(() => {
        phase = 'win';
        if (fireBtn) fireBtn.style.display = 'none';
        document.getElementById('win-screen').classList.add('show');
      }, 1600);  // wait for tongs anim
    }
  }
}

// ── Update ────────────────────────────────────────────────────────────────────
function update(dt) {
  if (phase !== 'playing') return;

  gPhase += dt / CFG.GAUGE_PERIOD * gDir;
  if (gPhase >= 1) { gPhase = 1; gDir = -1; }
  if (gPhase <= 0) { gPhase = 0; gDir =  1; }
  gVal = gPhase;

  let vx = 0, vy = 0;
  if (keys['ArrowLeft']  || keys['KeyA']) vx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) vx += 1;
  if (keys['ArrowUp']    || keys['KeyW']) vy -= 1;
  if (keys['ArrowDown']  || keys['KeyS']) vy += 1;
  if (joyTouch) { vx = joyTouch.dx; vy = joyTouch.dy; }
  xh.x = clamp(xh.x + vx * CFG.XH_SPD * dt, 50, W - 50);
  xh.y = clamp(xh.y + vy * CFG.XH_SPD * dt, 80, H - 80);

  for (const p of pots) {
    const prevState = p.state;
    p.stateT    += dt;
    p.flashGood  = Math.max(0, p.flashGood - dt * 2);
    p.flashBad   = Math.max(0, p.flashBad  - dt * 2.5);
    p.explodingT = Math.max(0, p.explodingT - dt);

    switch (p.state) {
      case 'idle':
        p.nextBoil -= dt; p.wobble = 0;
        if (p.nextBoil <= 0) { p.state = 'boiling'; p.stateT = 0; }
        break;

      case 'boiling':
        if (p.stateT >= CFG.BOIL_WIN_SEC) {
          p.state = 'idle'; p.stateT = 0;
          p.nextBoil = rnd(CFG.WARMUP_MIN, CFG.WARMUP_MAX);
          p.flashBad = 0.9;
        }
        p.wobble = Math.sin(Date.now() * 0.014) * 2.2 * p.s;
        if (Math.random() < dt * 7) steams.push(new Steam(p.bx, p.topY, p.s));
        break;

      case 'flying':
        if (Math.random() < dt * 3) steams.push(new Steam(p.bx, p.topY, p.s * 0.5));
        break;

      case 'cooking':
        if (p.stateT >= CFG.COOK_SEC) { p.state = 'ready'; p.stateT = 0; }
        if (Math.random() < dt * 3) steams.push(new Steam(p.bx, p.topY, p.s * 0.6));
        break;

      case 'ready':
        if (p.stateT >= CFG.REMOVE_SEC) {
          // Missed removal → EXPLOSION
          p.state = 'idle'; p.stateT = 0;
          p.nextBoil = rnd(CFG.WARMUP_MIN, CFG.WARMUP_MAX);
          p.explodingT = 1.4;
          explos.push(new Explosion(p));
          playMort();
        }
        p.wobble = Math.sin(Date.now() * 0.019) * 1.4 * p.s;
        break;
    }

    // Boiling sound: restart cleanly on every new boil transition
    if (prevState !== p.state) {
      if (prevState === 'boiling') p.stopBoil();
      if (p.state   === 'boiling') p.startBoil();
    }
  }

  // Projectiles
  for (const pr of projs) {
    pr.t = Math.min(1, pr.t + dt / 0.75); pr.ang += dt * 9;
    if (pr.t >= 1 && !pr.done) {
      pr.done = true; pr.pot.state = 'cooking'; pr.pot.stateT = 0;
    }
  }
  projs = projs.filter(p => !p.done);

  // Tongs
  for (const tg of tongs) tg.update(dt);
  tongs = tongs.filter(tg => !tg.done);

  // Explosions
  for (const ex of explos) ex.update(dt);
  explos = explos.filter(ex => !ex.done);

  // Steam
  for (const s of steams) s.update(dt);
  steams = steams.filter(s => s.a > 0.02);
  if (steams.length > 220) steams.splice(0, 50);
}

// ── Draw kitchen ──────────────────────────────────────────────────────────────
function drawKitchen() {
  const wallG = ctx.createLinearGradient(0, 0, 0, H * 0.70);
  wallG.addColorStop(0, '#d8c89a'); wallG.addColorStop(1, '#c6b082');
  ctx.fillStyle = wallG; ctx.fillRect(0, 0, W, H * 0.70);

  ctx.save(); ctx.beginPath(); ctx.rect(150, 188, 600, 132); ctx.clip();
  for (let ty = 188; ty < 320; ty += 30) {
    const row = Math.round((ty - 188) / 30);
    for (let tx = 150 + (row & 1) * 15; tx < 750; tx += 30) {
      ctx.fillStyle = (row + Math.round((tx - 150) / 30)) & 1 ? '#ddd3b2' : '#e9dfc4';
      ctx.fillRect(tx + 1, ty + 1, 28, 28);
      ctx.strokeStyle = '#c4b48a'; ctx.lineWidth = 0.5; ctx.strokeRect(tx + 1, ty + 1, 28, 28);
    }
  }
  ctx.restore();

  // Cabinets
  [[48, 20, 240, 145], [612, 20, 240, 145]].forEach(([x, y, w, h]) => {
    ctx.fillStyle = '#8a6218'; rrect(x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = '#4a340a'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = '#b08030'; ctx.lineWidth = 1.2; rrect(x + 10, y + 10, w - 20, h - 20, 4); ctx.stroke();
    ctx.fillStyle = '#ccA030'; ctx.fillRect(x + w / 2 - 20, y + h - 28, 40, 8);
  });

  // Window
  ctx.fillStyle = '#88c8f8'; rrect(310, 18, 180, 150, 5); ctx.fill();
  ctx.strokeStyle = '#d0e8ff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(400, 18); ctx.lineTo(400, 168); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(310, 93); ctx.lineTo(490, 93); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(313, 21, 84, 69);

  // Ceiling light
  ctx.fillStyle = '#f8f4e4'; ctx.fillRect(340, 0, 220, 14);
  const lgG = ctx.createLinearGradient(0, 14, 0, 72);
  lgG.addColorStop(0, 'rgba(255,252,210,0.30)'); lgG.addColorStop(1, 'rgba(255,252,210,0)');
  ctx.fillStyle = lgG;
  ctx.beginPath(); ctx.moveTo(320, 14); ctx.lineTo(580, 14); ctx.lineTo(520, 72); ctx.lineTo(380, 72); ctx.closePath(); ctx.fill();

  // Countertop
  const ctrG = ctx.createLinearGradient(0, H * 0.70, 0, H);
  ctrG.addColorStop(0, '#281606'); ctrG.addColorStop(0.12, '#4a2e10'); ctrG.addColorStop(1, '#1e1008');
  ctx.fillStyle = ctrG; ctx.fillRect(0, H * 0.70, W, H * 0.30);
  ctx.fillStyle = 'rgba(255,190,80,0.10)'; ctx.fillRect(0, H * 0.70, W, 4);

  // Stove body
  const stG = ctx.createLinearGradient(0, 192, 0, H * 0.84);
  stG.addColorStop(0, '#2c2c2c'); stG.addColorStop(1, '#171717');
  ctx.fillStyle = stG;
  ctx.beginPath(); ctx.moveTo(175, 192); ctx.lineTo(725, 192); ctx.lineTo(772, H * 0.84); ctx.lineTo(128, H * 0.84); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = 1.5; ctx.stroke();

  const sy1 = H * 0.79, sy2 = H * 0.84;
  ctx.fillStyle = '#1c1c1c'; ctx.fillRect(128, sy1, 644, sy2 - sy1);
  [215, 265, 635, 685].forEach(kx => {
    const ky = (sy1 + sy2) / 2;
    const kg = ctx.createRadialGradient(kx - 2, ky - 2, 1, kx, ky, 11);
    kg.addColorStop(0, '#888'); kg.addColorStop(1, '#2a2a2a');
    ctx.fillStyle = kg; ctx.beginPath(); ctx.arc(kx, ky, 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(kx, ky - 4); ctx.lineTo(kx, ky - 9); ctx.stroke();
  });
}

// ── Draw burner ───────────────────────────────────────────────────────────────
function drawBurner(pot) {
  const { bx, by, rx, ry, s, state } = pot;
  const active = state !== 'idle';
  if (active) {
    const gl = ctx.createRadialGradient(bx, by, 0, bx, by, rx * 1.6);
    gl.addColorStop(0, 'rgba(255,140,20,0.42)'); gl.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.ellipse(bx, by, rx * 1.7, ry * 2.4, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Date.now() * 0.003;
      const fl = 0.82 + Math.sin(Date.now() * 0.022 + i * 1.2) * 0.18;
      ctx.strokeStyle = i % 2 ? '#ff6600' : '#ffaa00'; ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(a) * rx * 0.42, by + Math.sin(a) * ry * 0.42);
      ctx.lineTo(bx + Math.cos(a) * rx * fl,   by + Math.sin(a) * ry * fl);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = active ? '#bb3300' : '#1e1e1e'; ctx.lineWidth = active ? 5 * s : 4 * s;
  ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = active ? '#ff5522' : '#0e0e0e'; ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.ellipse(bx, by, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2); ctx.stroke();
}

// ── Draw pot ──────────────────────────────────────────────────────────────────
function drawPot(pot) {
  if (pot.explodingT > 0.6) return;  // hidden during explosion start
  const alpha = pot.explodingT > 0 ? pot.explodingT / 0.6 : 1;
  ctx.globalAlpha = alpha;

  const { s, state, stateT, flashGood, flashBad } = pot;
  const cx2 = pot.px, cy2 = pot.by, { rx, ry, h } = pot;
  const topY = cy2 - h;

  // Sides
  const bodyG = ctx.createLinearGradient(cx2 - rx, 0, cx2 + rx, 0);
  bodyG.addColorStop(0, '#242424'); bodyG.addColorStop(0.25, '#525252');
  bodyG.addColorStop(0.5, '#686868'); bodyG.addColorStop(0.75, '#525252'); bodyG.addColorStop(1, '#242424');
  ctx.fillStyle = bodyG; ctx.fillRect(cx2 - rx, topY, rx * 2, h);

  // Bottom ellipse
  ctx.fillStyle = '#161616'; ctx.beginPath(); ctx.ellipse(cx2, cy2, rx, ry, 0, 0, Math.PI * 2); ctx.fill();

  // Handles
  ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 5 * s;
  ctx.beginPath(); ctx.arc(cx2 - rx - 5 * s, topY + h * 0.45, 7 * s,  0.55, Math.PI * 1.45); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx2 + rx + 5 * s, topY + h * 0.45, 7 * s, -0.45, Math.PI * 0.45); ctx.stroke();

  // Homard visible inside when cooking/ready
  const showInside = (state === 'cooking' || state === 'ready') && imgsReady >= 1;
  if (showInside) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx - 1, ry - 0.5, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(140,60,10,0.75)'; ctx.fill();
    const hW = rx * 2.0;
    ctx.drawImage(imgHomard, cx2 - hW / 2, topY - hW * 0.48, hW, hW * 0.96);
    ctx.fillStyle = 'rgba(200,60,0,0.18)'; ctx.fill();
    ctx.restore();
  }

  // Lid (raised when cooking/ready)
  const lidRaise = showInside ? 7 * s : 0;
  const lidY = topY - lidRaise;
  const lidG = ctx.createLinearGradient(cx2 - rx, lidY, cx2 + rx, lidY);
  lidG.addColorStop(0, '#2e2e2e'); lidG.addColorStop(0.4, '#707070');
  lidG.addColorStop(0.6, '#707070'); lidG.addColorStop(1, '#2e2e2e');
  ctx.fillStyle = lidG; ctx.beginPath(); ctx.ellipse(cx2, lidY, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(cx2, lidY, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx2, lidY - 1, rx * 0.85, ry * 0.85, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#5a5a5a'; ctx.beginPath(); ctx.ellipse(cx2, lidY - ry, 5 * s, 3 * s, 0, 0, Math.PI * 2); ctx.fill();

  // State labels
  if (state === 'boiling') {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.008);
    ctx.strokeStyle = `rgba(60,160,255,${0.55 + pulse * 0.45})`;
    ctx.lineWidth   = 3 * s + pulse * 2;
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx + 8 + pulse * 6, ry + 3 + pulse * 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.save(); ctx.font = `bold ${Math.round(11 * s + 1)}px sans-serif`;
    ctx.fillStyle = `rgba(100,190,255,${0.7 + pulse * 0.3})`; ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
    ctx.fillText('VISER + ESPACE', cx2, topY - ry - 13 * s); ctx.restore();
  }

  if (state === 'cooking') {
    const prog = Math.min(1, stateT / CFG.COOK_SEC);
    const secs = Math.max(0, Math.ceil(CFG.COOK_SEC - stateT));
    ctx.strokeStyle = '#ff9900'; ctx.lineWidth = 4 * s;
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx * 0.76, ry * 0.76, -Math.PI / 2, 0, Math.PI * 2 * prog); ctx.stroke();
    ctx.save(); ctx.font = `bold ${Math.round(11 * s)}px sans-serif`;
    ctx.fillStyle = '#ffcc55'; ctx.textAlign = 'center'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`⏱ ${secs}s`, cx2, topY - ry - 10 * s); ctx.restore();
  }

  if (state === 'ready') {
    const urgency = stateT / CFG.REMOVE_SEC;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.016);
    const col = urgency > 0.55 ? `rgba(255,90,60,${0.65 + pulse * 0.35})` : `rgba(60,230,100,${0.65 + pulse * 0.35})`;
    ctx.strokeStyle = col; ctx.lineWidth = 4 * s + pulse * 2;
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx + 12 + pulse * 8, ry + 4 + pulse * 3, 0, 0, Math.PI * 2); ctx.stroke();
    const secs = Math.max(0, Math.ceil(CFG.REMOVE_SEC - stateT));
    ctx.save(); ctx.font = `bold ${Math.round(12 * s)}px sans-serif`;
    ctx.fillStyle = urgency > 0.55 ? '#ff7755' : '#55ff88'; ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
    ctx.fillText(`🦞 SORTIR ! ${secs}s`, cx2, topY - ry - 13 * s); ctx.restore();
  }

  if (flashGood > 0) {
    ctx.fillStyle = `rgba(80,255,120,${flashGood * 0.38})`;
    ctx.beginPath(); ctx.ellipse(cx2, topY + h * 0.3, rx * 1.25, (h + ry) * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (flashBad > 0) {
    ctx.fillStyle = `rgba(255,60,40,${flashBad * 0.38})`;
    ctx.beginPath(); ctx.ellipse(cx2, topY + h * 0.3, rx * 1.25, (h + ry) * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  }

  ctx.globalAlpha = 1;
}

// ── Draw steam ────────────────────────────────────────────────────────────────
function drawSteam() {
  for (const s of steams) {
    ctx.fillStyle = `rgba(215,215,215,${s.a * 0.28})`;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (0.5 + s.a * 0.5), 0, Math.PI * 2); ctx.fill();
  }
}

// ── Draw projectiles ──────────────────────────────────────────────────────────
function drawProjs() {
  for (const pr of projs) {
    if (imgsReady < 1) continue;
    ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.ang);
    ctx.drawImage(imgHomard, -pr.sz / 2, -pr.sz / 2, pr.sz, pr.sz);
    ctx.restore();
  }
}

// ── Draw tongs ────────────────────────────────────────────────────────────────
function drawTongs(tg) {
  const { tipY, openAngle, isLifting, liftProgress, pot } = tg;
  const x   = pot.bx;
  const s   = pot.s;
  const ARM = 78 * s;   // pivot to tip
  const HND = 52 * s;   // handle length above pivot

  const pivY     = tipY - ARM;
  const spreadT  = Math.sin(openAngle) * 24 * s;   // spread at tip
  const spreadH  = 8 * s;                           // small gap at handle top

  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = '#00000099'; ctx.shadowBlur = 6;

  // Main arms (handle top → pivot → grip tip)
  ctx.strokeStyle = '#c8cad4'; ctx.lineWidth = 5 * s;
  ctx.beginPath(); ctx.moveTo(x - spreadH, pivY - HND); ctx.lineTo(x, pivY); ctx.lineTo(x - spreadT, tipY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + spreadH, pivY - HND); ctx.lineTo(x, pivY); ctx.lineTo(x + spreadT, tipY); ctx.stroke();

  // Pivot rivet
  ctx.fillStyle = '#909090'; ctx.beginPath(); ctx.arc(x, pivY, 4 * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d0d0d0'; ctx.beginPath(); ctx.arc(x, pivY, 2.5 * s, 0, Math.PI * 2); ctx.fill();

  // Handle loops at top
  ctx.strokeStyle = '#a0a2ac'; ctx.lineWidth = 3 * s;
  ctx.beginPath(); ctx.ellipse(x - spreadH, pivY - HND - 8 * s, 8 * s, 6 * s, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(x + spreadH, pivY - HND - 8 * s, 8 * s, 6 * s, 0, 0, Math.PI * 2); ctx.stroke();

  // Grip serrations at tip
  ctx.strokeStyle = '#787888'; ctx.lineWidth = 7 * s;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - spreadT, tipY); ctx.lineTo(x - spreadT * 0.5, tipY + 10 * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + spreadT, tipY); ctx.lineTo(x + spreadT * 0.5, tipY + 10 * s); ctx.stroke();

  // Lobster being carried during lift
  if (isLifting && imgsReady >= 1) {
    const alpha = Math.max(0, 1 - liftProgress * 0.85);
    const sz    = pot.rx * 1.85;
    ctx.globalAlpha = alpha;
    ctx.drawImage(imgHomard, x - sz / 2, tipY - sz * 0.32, sz, sz * 0.9);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ── Draw explosions ───────────────────────────────────────────────────────────
function drawExplosions() {
  for (const ex of explos) {
    const globalAlpha = Math.max(0, 1 - ex.t / 1.6);

    // Shockwave ring
    if (ex.t < 0.45) {
      const r  = ex.t / 0.45;
      const gw = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r * 95 * ex.s);
      gw.addColorStop(0, 'rgba(255,220,60,0)');
      gw.addColorStop(0.7, `rgba(255,160,30,${(1 - r) * 0.6})`);
      gw.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = gw;
      ctx.beginPath(); ctx.arc(ex.x, ex.y, r * 95 * ex.s, 0, Math.PI * 2); ctx.fill();
    }

    // Particles
    for (const p of ex.particles) {
      const age = Math.max(0, 1 - ex.t / 1.4);
      ctx.save(); ctx.globalAlpha = age * globalAlpha;

      if (p.type === 'lobster' && imgsReady >= 1) {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        const sz = p.r * 2.2;
        ctx.drawImage(imgHomard, -sz / 2, -sz / 2, sz, sz);
      } else if (p.type === 'shard') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r * 0.6, -p.r * 0.4, p.r * 1.2, p.r * 0.8);
      } else {
        // Fire circle
        const fg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        fg.addColorStop(0, p.color + 'ff');
        fg.addColorStop(1, p.color + '00');
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // "RATÉ !" arcade text
    if (ex.t < 0.9) {
      const textAlpha = Math.max(0, 1 - ex.t / 0.9);
      const rise = ex.t * 55;
      ctx.save();
      ctx.globalAlpha = textAlpha;
      ctx.font = `bold ${Math.round(22 * ex.s)}px sans-serif`;
      ctx.fillStyle = '#ff4400';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#ff2200'; ctx.shadowBlur = 14;
      ctx.strokeText('RATÉ !', ex.x, ex.y - 20 * ex.s - rise);
      ctx.fillText('RATÉ !',   ex.x, ex.y - 20 * ex.s - rise);
      ctx.restore();
    }
  }
}

// ── Draw crosshair ────────────────────────────────────────────────────────────
function drawCrosshair() {
  const { x, y } = xh;
  const tgt = pots.find(p => p.hit(x, y) && (p.state === 'boiling' || p.state === 'ready'));
  const col = tgt ? (tgt.state === 'ready' ? '#55ff88' : '#55bbff') : 'rgba(255,255,255,0.88)';
  ctx.save();
  ctx.strokeStyle = col; ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  [[0,-1],[0,1],[-1,0],[1,0]].forEach(([dx,dy]) => {
    ctx.beginPath(); ctx.moveTo(x + dx * 20, y + dy * 20); ctx.lineTo(x + dx * 33, y + dy * 33); ctx.stroke();
  });
  if (tgt) {
    ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(x, y, 23, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

// ── Draw gauge ────────────────────────────────────────────────────────────────
function drawGauge() {
  const gx = W / 2 - 170, gy = H - 52, gw = 340, gh = 24;
  ctx.fillStyle = 'rgba(0,0,0,0.70)'; rrect(gx - 6, gy - 6, gw + 12, gh + 12, 8); ctx.fill();
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = `hsl(${lerp(220, 0, gVal)},88%,52%)`; ctx.fillRect(gx, gy, gw * gVal, gh);
  const zx1 = gx + gw * CFG.G_MIN, zx2 = gx + gw * CFG.G_MAX;
  ctx.fillStyle = 'rgba(100,255,100,0.22)'; ctx.fillRect(zx1, gy, zx2 - zx1, gh);
  ctx.strokeStyle = '#55ee55'; ctx.lineWidth = 2; ctx.strokeRect(zx1, gy, zx2 - zx1, gh);
  ctx.fillStyle = '#fff'; ctx.fillRect(gx + gw * gVal - 2, gy - 7, 4, gh + 14);
  ctx.save();
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#77ee77'; ctx.textAlign = 'center';
  ctx.fillText('70%', zx1, gy - 7); ctx.fillText('90%', zx2, gy - 7);
  ctx.fillStyle = '#bbb'; ctx.textAlign = 'left'; ctx.font = 'bold 12px sans-serif';
  ctx.fillText('⚡ ÉNERGIE', gx, gy - 7);
  ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
  ctx.fillText('[ ESPACE / tap droit ]', W / 2, gy + gh + 16);
  ctx.restore();
}

// ── Draw HUD ──────────────────────────────────────────────────────────────────
function drawHUD() {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; rrect(12, 10, 154, 40, 8); ctx.fill();
  ctx.font = 'bold 21px Georgia, serif'; ctx.fillStyle = '#fff';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 5; ctx.textAlign = 'left';
  ctx.fillText(`🦞 ${score} / ${CFG.WIN}`, 22, 37);
  ctx.textAlign = 'center'; ctx.font = '15px sans-serif';
  pots.forEach((p, i) => {
    const icon = { idle:'⬛', boiling:'🔵', cooking:'🟠', flying:'🟠', ready:'🟢' }[p.state] ?? '⬛';
    ctx.fillText(icon, W - 18 - i * 30, 32);
  });
  ctx.restore();
}

// ── Draw welcome ──────────────────────────────────────────────────────────────
function drawWelcome() {
  ctx.fillStyle = 'rgba(8,4,0,0.80)'; ctx.fillRect(0, 0, W, H);

  if (imgsReady >= 2) {
    ctx.drawImage(imgSalut, W * 0.54, H * 0.38, 265, 200);
    const bx = W * 0.54 + 265 * 0.44, by = H * 0.12, bw = 218, bh = 154;
    ctx.fillStyle = 'rgba(255,252,240,0.97)'; rrect(bx, by, bw, bh, 14); ctx.fill();
    ctx.strokeStyle = '#cc3300'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx+32,by+bh); ctx.lineTo(bx+10,by+bh+28); ctx.lineTo(bx+62,by+bh); ctx.closePath();
    ctx.fillStyle = 'rgba(255,252,240,0.97)'; ctx.fill();
    ctx.strokeStyle = '#cc3300'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx+10,by+bh+28); ctx.lineTo(bx+10,by+bh+1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx+10,by+bh+28); ctx.lineTo(bx+62,by+bh+1); ctx.stroke();
    ctx.fillStyle = '#330000'; ctx.textAlign = 'left'; ctx.font = 'bold 14px Georgia, serif';
    ['Salut ! Cuit 5 homards','pour mériter ton','invitation au souper ! 🦞'].forEach((l, i) => ctx.fillText(l, bx+12, by+30+i*24));
  }

  const rx = 36, ry = 22, rw = W * 0.47, rh = H * 0.89;
  ctx.fillStyle = 'rgba(16,7,0,0.93)'; rrect(rx, ry, rw, rh, 16); ctx.fill();
  ctx.strokeStyle = '#cc4d1a'; ctx.lineWidth = 2.5; ctx.stroke();

  ctx.save();
  ctx.textAlign = 'center'; ctx.fillStyle = '#ff9944'; ctx.font = 'bold 25px Georgia, serif';
  ctx.shadowColor = '#cc2200'; ctx.shadowBlur = 14;
  ctx.fillText('🦞 Souper Homard 🦞', rx + rw / 2, ry + 46); ctx.shadowBlur = 0;
  ctx.fillStyle = '#e0d0b0'; ctx.font = '14.5px Georgia, serif'; ctx.textAlign = 'left';
  [
    '🔵 Quand une casserole bout, vise-la.',
    '⚡ Presse ESPACE entre 70 et 90%',
    '   de la jauge pour lancer le homard.',
    '🟠 Le homard cuit pendant 15 secondes.',
    '🟢 Après cuisson, vise + ESPACE',
    '   dans les 10 secondes pour le sortir.',
    '♻️  Les casseroles rebouillent après !',
    '🏆 5 homards réussis = invitation gagnée !',
    '',
    '🖥  Flèches / WASD pour viser, ESPACE',
    '📱 Glisse gauche pour viser, tap droit',
  ].forEach((l, i) => ctx.fillText(l, rx + 18, ry + 82 + i * 30));

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.004);
  const btnX = rx + rw / 2 - 130, btnY = ry + rh - 68, btnW = 260, btnH = 50;
  ctx.fillStyle = `rgba(${Math.round(175 + pulse * 35)},46,12,0.95)`;
  rrect(btnX, btnY, btnW, btnH, 12); ctx.fill();
  ctx.strokeStyle = '#ff7733'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Georgia, serif'; ctx.textAlign = 'center';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillText('▶  Lancer', rx + rw / 2, btnY + 32);
  ctx.restore();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, W, H);
  drawKitchen();
  pots.forEach(p => drawBurner(p));
  drawSteam();
  pots.forEach(p => drawPot(p));
  drawProjs();
  drawExplosions();
  tongs.forEach(tg => drawTongs(tg));

  if (phase === 'playing') { drawCrosshair(); drawGauge(); drawHUD(); }
  if (phase === 'welcome') drawWelcome();

  if (phase === 'playing' && joyTouch) {
    const { ox, oy, dx, dy } = joyTouch;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, 36, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.arc(ox + dx * 28, oy + dy * 28, 16, 0, Math.PI * 2); ctx.fill();
  }
}

// ── Loop ──────────────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min((ts - lastT) / 1000, 0.05);
  lastT = ts; update(dt); render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(ts => { lastT = ts; requestAnimationFrame(loop); });
