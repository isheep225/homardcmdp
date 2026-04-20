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
  COOK_SEC:     30,
  REMOVE_SEC:   10,
  BOIL_WIN_SEC: 18,
  GAUGE_PERIOD: 1,    // seconds per full 0→1→0 cycle
  G_MIN: 0.70,
  G_MAX: 0.90,
  XH_SPD: 320,
  WARMUP_MIN:   4,
  WARMUP_MAX:   13,
  COOLDOWN_MIN: 6,
  COOLDOWN_MAX: 16,
};

// ── Pot layout ────────────────────────────────────────────────────────────────
// bx/by = center-bottom of pot body; s = depth scale
const POT_DEFS = [
  { id: 0, bx: 302, by: 292, s: 0.70 },  // back-left
  { id: 1, bx: 598, by: 292, s: 0.70 },  // back-right
  { id: 2, bx: 236, by: 432, s: 1.00 },  // front-left
  { id: 3, bx: 664, by: 432, s: 1.00 },  // front-right
];
const BASE = { rx: 68, ry: 21, h: 72 };

// ── Runtime state ─────────────────────────────────────────────────────────────
let phase  = 'welcome';
let score  = 0;
let gDir   = 1;
let gPhase = 0;   // 0..1 within one half-cycle
let gVal   = 0;   // displayed gauge value 0..1
let xh     = { x: W / 2, y: H * 0.62 };
let pots   = [];
let projs  = [];
let steams = [];
let keys   = {};
let spaceLocked = false;
let lastT  = 0;
let joyTouch = null;  // { id, ox, oy, dx, dy }
const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// ── Audio ─────────────────────────────────────────────────────────────────────
const bgMusic = new Audio('assets/italie.mp3');
bgMusic.loop   = true;
bgMusic.volume = 0.45;
let musicStarted = false;
function tryStartMusic() {
  if (!musicStarted) {
    bgMusic.play().catch(() => {});
    musicStarted = true;
  }
}

const sndThrow = new Audio('assets/throw.mp3');
sndThrow.volume = 0.8;
function playThrow() {
  sndThrow.currentTime = 0;
  sndThrow.play().catch(() => {});
}

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
const lerp  = (a, b, t)  => a + (b - a) * t;

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
    this.id = d.id;
    this.bx = d.bx;
    this.by = d.by;
    this.s  = d.s;
    this.rx = BASE.rx * d.s;
    this.ry = BASE.ry * d.s;
    this.h  = BASE.h  * d.s;

    this.state     = 'idle';
    this.stateT    = 0;
    this.nextBoil  = rnd(CFG.WARMUP_MIN, CFG.WARMUP_MAX);
    this.wobble    = 0;
    this.flashGood = 0;
    this.flashBad  = 0;

    this.boilSound = new Audio('assets/eau.mp3');
    this.boilSound.loop   = true;
    this.boilSound.volume = 0.45;
  }
  get topY() { return this.by - this.h; }
  get px()   { return this.bx + this.wobble; }  // wobbled x

  hit(px, py) {
    const dx = (px - this.bx) / (this.rx * 1.5);
    const dy = (py - (this.by - this.h * 0.5)) / (this.h * 0.9);
    return dx * dx + dy * dy < 1;
  }
}

// ── Projectile class ──────────────────────────────────────────────────────────
class Proj {
  constructor(pot) {
    this.pot  = pot;
    this.t    = 0;
    this.ang  = 0;
    this.done = false;
  }
  get x() {
    const e = this.t * this.t * (3 - 2 * this.t);
    return lerp(W / 2, this.pot.bx, e);
  }
  get y() {
    const e = this.t * this.t * (3 - 2 * this.t);
    return lerp(H + 50, this.pot.topY + 6, e) - 240 * this.pot.s * Math.sin(Math.PI * this.t);
  }
  get sz() { return lerp(130, 65 * this.pot.s, this.t); }
}

// ── Steam particle ────────────────────────────────────────────────────────────
class Steam {
  constructor(x, y, s) {
    this.x  = x + rnd(-12, 12) * s;
    this.y  = y;
    this.vx = rnd(-14, 14) * s;
    this.vy = rnd(-65, -105) * s;
    this.r  = rnd(4, 9) * s;
    this.a  = 1;
    this.da = rnd(0.5, 0.9);
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.a  = Math.max(0, this.a - this.da * dt);
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

canvas.addEventListener('click', () => {
  if (phase === 'welcome') startGame();
});

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = toCanvas(t);
    if (phase === 'welcome') { startGame(); return; }
    if (phase !== 'playing') return;
    if (p.x > W * 0.62) {
      doAction();
    } else {
      joyTouch = { id: t.identifier, ox: p.x, oy: p.y, dx: 0, dy: 0 };
    }
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
  return {
    x: (touch.clientX - r.left) / r.width  * W,
    y: (touch.clientY - r.top)  / r.height * H,
  };
}

// ── Game logic ────────────────────────────────────────────────────────────────
function startGame() {
  pots.forEach(p => { p.boilSound.pause(); p.boilSound.currentTime = 0; });
  score      = 0;
  gPhase     = 0;  gDir = 1;  gVal = 0;
  xh         = { x: W / 2, y: H * 0.62 };
  pots       = POT_DEFS.map(d => new Pot(d));
  projs      = [];
  steams     = [];
  spaceLocked = false;
  phase      = 'playing';
  if (fireBtn && isTouchDevice) fireBtn.style.display = 'flex';
  tryStartMusic();
}

function doAction() {
  const target = pots.find(p => p.hit(xh.x, xh.y));
  if (!target) return;

  if (target.state === 'boiling') {
    if (gVal >= CFG.G_MIN && gVal <= CFG.G_MAX) {
      target.state  = 'flying';
      target.stateT = 0;
      target.flashGood = 0.9;
      target.boilSound.pause();
      playThrow();
      projs.push(new Proj(target));
    } else {
      target.flashBad = 0.8;
    }
  } else if (target.state === 'ready') {
    target.state    = 'idle';
    target.stateT   = 0;
    target.nextBoil = rnd(CFG.COOLDOWN_MIN, CFG.COOLDOWN_MAX);
    target.flashGood = 1;
    target.wobble   = 0;
    score++;
    if (score >= CFG.WIN) {
      setTimeout(() => {
        phase = 'win';
        if (fireBtn) fireBtn.style.display = 'none';
        document.getElementById('win-screen').classList.add('show');
      }, 600);
    }
  }
}

// ── Update ────────────────────────────────────────────────────────────────────
function update(dt) {
  if (phase !== 'playing') return;

  // Gauge cycles 0→1→0 every GAUGE_PERIOD seconds
  gPhase += dt / CFG.GAUGE_PERIOD * gDir;
  if (gPhase >= 1) { gPhase = 1; gDir = -1; }
  if (gPhase <= 0) { gPhase = 0; gDir =  1; }
  gVal = gPhase;

  // Crosshair
  let vx = 0, vy = 0;
  if (keys['ArrowLeft']  || keys['KeyA']) vx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) vx += 1;
  if (keys['ArrowUp']    || keys['KeyW']) vy -= 1;
  if (keys['ArrowDown']  || keys['KeyS']) vy += 1;
  if (joyTouch) { vx = joyTouch.dx; vy = joyTouch.dy; }
  const spd = CFG.XH_SPD * dt;
  xh.x = clamp(xh.x + vx * spd, 50, W - 50);
  xh.y = clamp(xh.y + vy * spd, 80, H - 80);

  // Pots
  for (const p of pots) {
    const prevState = p.state;
    p.stateT  += dt;
    p.flashGood = Math.max(0, p.flashGood - dt * 2);
    p.flashBad  = Math.max(0, p.flashBad  - dt * 2.5);

    switch (p.state) {
      case 'idle':
        p.nextBoil -= dt;
        p.wobble    = 0;
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
          p.state = 'idle'; p.stateT = 0;
          p.nextBoil = rnd(CFG.WARMUP_MIN, CFG.WARMUP_MAX);
          p.flashBad = 1;
        }
        p.wobble = Math.sin(Date.now() * 0.019) * 1.4 * p.s;
        break;
    }

    // Sound transitions
    if (prevState !== p.state) {
      if (prevState === 'boiling') { p.boilSound.pause(); p.boilSound.currentTime = 0; }
      if (p.state    === 'boiling') { p.boilSound.play().catch(() => {}); }
    }
  }

  // Projectiles
  for (const pr of projs) {
    pr.t   = Math.min(1, pr.t + dt / 0.75);
    pr.ang += dt * 9;
    if (pr.t >= 1 && !pr.done) {
      pr.done = true;
      pr.pot.state  = 'cooking';
      pr.pot.stateT = 0;
    }
  }
  projs = projs.filter(p => !p.done);

  // Steam
  for (const s of steams) s.update(dt);
  steams = steams.filter(s => s.a > 0.02);
  if (steams.length > 220) steams.splice(0, 50);
}

// ── Draw kitchen ──────────────────────────────────────────────────────────────
function drawKitchen() {
  // Wall
  const wallG = ctx.createLinearGradient(0, 0, 0, H * 0.70);
  wallG.addColorStop(0, '#d8c89a');
  wallG.addColorStop(1, '#c6b082');
  ctx.fillStyle = wallG;
  ctx.fillRect(0, 0, W, H * 0.70);

  // Tile backsplash (behind the stove area, y 188..320)
  ctx.save();
  ctx.beginPath();
  ctx.rect(150, 188, 600, 132);
  ctx.clip();
  for (let ty = 188; ty < 320; ty += 30) {
    const row = Math.round((ty - 188) / 30);
    for (let tx = 150 + (row & 1) * 15; tx < 750; tx += 30) {
      ctx.fillStyle = (row + Math.round((tx - 150) / 30)) & 1 ? '#ddd3b2' : '#e9dfc4';
      ctx.fillRect(tx + 1, ty + 1, 28, 28);
      ctx.strokeStyle = '#c4b48a'; ctx.lineWidth = 0.5;
      ctx.strokeRect(tx + 1, ty + 1, 28, 28);
    }
  }
  ctx.restore();

  // Left cabinet
  ctx.fillStyle = '#8a6218';
  rrect(48, 20, 240, 145, 6); ctx.fill();
  ctx.strokeStyle = '#4a340a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = '#b08030'; ctx.lineWidth = 1.2;
  rrect(58, 30, 220, 125, 4); ctx.stroke();
  ctx.fillStyle = '#ccA030';
  ctx.fillRect(148, 125, 40, 8);

  // Right cabinet
  ctx.fillStyle = '#8a6218';
  rrect(612, 20, 240, 145, 6); ctx.fill();
  ctx.strokeStyle = '#4a340a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = '#b08030'; ctx.lineWidth = 1.2;
  rrect(622, 30, 220, 125, 4); ctx.stroke();
  ctx.fillStyle = '#ccA030';
  ctx.fillRect(712, 125, 40, 8);

  // Center window (between cabinets)
  ctx.fillStyle = '#88c8f8';
  rrect(310, 18, 180, 150, 5); ctx.fill();
  ctx.strokeStyle = '#d0e8ff'; ctx.lineWidth = 2; ctx.stroke();
  // Window frame cross
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(400, 18); ctx.lineTo(400, 168); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(310, 93); ctx.lineTo(490, 93); ctx.stroke();
  // Window light
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(313, 21, 84, 69);

  // Ceiling strip light
  ctx.fillStyle = '#f8f4e4';
  ctx.fillRect(340, 0, 220, 14);
  const lgG = ctx.createLinearGradient(0, 14, 0, 72);
  lgG.addColorStop(0, 'rgba(255,252,210,0.30)');
  lgG.addColorStop(1, 'rgba(255,252,210,0)');
  ctx.fillStyle = lgG;
  ctx.beginPath(); ctx.moveTo(320, 14); ctx.lineTo(580, 14); ctx.lineTo(520, 72); ctx.lineTo(380, 72); ctx.closePath();
  ctx.fill();

  // Countertop
  const ctrG = ctx.createLinearGradient(0, H * 0.70, 0, H);
  ctrG.addColorStop(0,    '#281606');
  ctrG.addColorStop(0.12, '#4a2e10');
  ctrG.addColorStop(1,    '#1e1008');
  ctx.fillStyle = ctrG;
  ctx.fillRect(0, H * 0.70, W, H * 0.30);
  ctx.fillStyle = 'rgba(255,190,80,0.10)';
  ctx.fillRect(0, H * 0.70, W, 4);

  // Stove body (trapezoid)
  const stG = ctx.createLinearGradient(0, 192, 0, H * 0.84);
  stG.addColorStop(0, '#2c2c2c');
  stG.addColorStop(1, '#171717');
  ctx.fillStyle = stG;
  ctx.beginPath();
  ctx.moveTo(175, 192);
  ctx.lineTo(725, 192);
  ctx.lineTo(772, H * 0.84);
  ctx.lineTo(128, H * 0.84);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = 1.5; ctx.stroke();

  // Stove front strip
  ctx.fillStyle = '#1c1c1c';
  const sy1 = H * 0.79, sy2 = H * 0.84;
  ctx.fillRect(128, sy1, 644, sy2 - sy1);

  // Control knobs
  [215, 265, 635, 685].forEach(kx => {
    const ky = (sy1 + sy2) / 2;
    const kg = ctx.createRadialGradient(kx - 2, ky - 2, 1, kx, ky, 11);
    kg.addColorStop(0, '#888'); kg.addColorStop(1, '#2a2a2a');
    ctx.fillStyle = kg;
    ctx.beginPath(); ctx.arc(kx, ky, 11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(kx, ky - 4); ctx.lineTo(kx, ky - 9); ctx.stroke();
  });
}

// ── Draw one burner ───────────────────────────────────────────────────────────
function drawBurner(pot) {
  const { bx, by, rx, ry, s, state } = pot;
  const active = state !== 'idle';

  if (active) {
    const gl = ctx.createRadialGradient(bx, by, 0, bx, by, rx * 1.6);
    gl.addColorStop(0, 'rgba(255,140,20,0.42)');
    gl.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.ellipse(bx, by, rx * 1.7, ry * 2.4, 0, 0, Math.PI * 2); ctx.fill();

    // Animated flame segments
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Date.now() * 0.003;
      const fl = 0.82 + Math.sin(Date.now() * 0.022 + i * 1.2) * 0.18;
      ctx.strokeStyle = i % 2 ? '#ff6600' : '#ffaa00';
      ctx.lineWidth   = 2 * s;
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(a) * rx * 0.42, by + Math.sin(a) * ry * 0.42);
      ctx.lineTo(bx + Math.cos(a) * rx * fl,   by + Math.sin(a) * ry * fl);
      ctx.stroke();
    }
  }

  // Burner rings
  ctx.strokeStyle = active ? '#bb3300' : '#1e1e1e';
  ctx.lineWidth   = active ? 5 * s : 4 * s;
  ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = active ? '#ff5522' : '#0e0e0e';
  ctx.lineWidth   = 2 * s;
  ctx.beginPath(); ctx.ellipse(bx, by, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2); ctx.stroke();
}

// ── Draw one pot ──────────────────────────────────────────────────────────────
function drawPot(pot) {
  const { s, state, stateT, flashGood, flashBad } = pot;
  const cx2  = pot.px;        // wobble-adjusted x
  const cy2  = pot.by;        // bottom rim y
  const { rx, ry, h } = pot;
  const topY = cy2 - h;

  // Side walls — rectangle with horizontal gradient
  const bodyG = ctx.createLinearGradient(cx2 - rx, 0, cx2 + rx, 0);
  bodyG.addColorStop(0,    '#242424');
  bodyG.addColorStop(0.25, '#525252');
  bodyG.addColorStop(0.5,  '#686868');
  bodyG.addColorStop(0.75, '#525252');
  bodyG.addColorStop(1,    '#242424');
  ctx.fillStyle = bodyG;
  ctx.fillRect(cx2 - rx, topY, rx * 2, h);

  // Bottom ellipse (closes the cylinder bottom)
  ctx.fillStyle = '#161616';
  ctx.beginPath(); ctx.ellipse(cx2, cy2, rx, ry, 0, 0, Math.PI * 2); ctx.fill();

  // Handles
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth   = 5 * s;
  ctx.beginPath(); ctx.arc(cx2 - rx - 5 * s, topY + h * 0.45, 7 * s,  0.55, Math.PI * 1.45); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx2 + rx + 5 * s, topY + h * 0.45, 7 * s, -0.45, Math.PI * 0.45); ctx.stroke();

  // Homard visible inside when cooking or ready
  const showInside = (state === 'cooking' || state === 'ready') && imgsReady >= 1;
  if (showInside) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx2, topY, rx - 1, ry - 0.5, 0, 0, Math.PI * 2);
    ctx.clip();
    // Broth
    ctx.fillStyle = 'rgba(140,60,10,0.75)';
    ctx.fill();
    // Homard image (top-down, fitted in ellipse)
    const hW = rx * 2.0;
    ctx.drawImage(imgHomard, cx2 - hW / 2, topY - hW * 0.48, hW, hW * 0.96);
    // Slight red-orange cooking tint
    ctx.fillStyle = 'rgba(200,60,0,0.18)';
    ctx.fill();
    ctx.restore();
  }

  // Lid — raised when cooking/ready to reveal contents
  const lidRaise = showInside ? 7 * s : 0;
  const lidY = topY - lidRaise;
  const lidG = ctx.createLinearGradient(cx2 - rx, lidY, cx2 + rx, lidY);
  lidG.addColorStop(0,   '#2e2e2e');
  lidG.addColorStop(0.4, '#707070');
  lidG.addColorStop(0.6, '#707070');
  lidG.addColorStop(1,   '#2e2e2e');
  ctx.fillStyle = lidG;
  ctx.beginPath(); ctx.ellipse(cx2, lidY, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(cx2, lidY, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  // Highlight bevel
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx2, lidY - 1, rx * 0.85, ry * 0.85, 0, 0, Math.PI * 2); ctx.stroke();
  // Lid knob
  ctx.fillStyle = '#5a5a5a';
  ctx.beginPath(); ctx.ellipse(cx2, lidY - ry, 5 * s, 3 * s, 0, 0, Math.PI * 2); ctx.fill();

  // ── State visuals ──────────────────────────────────────────────────────────
  if (state === 'boiling') {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.008);
    ctx.strokeStyle = `rgba(60,160,255,${0.55 + pulse * 0.45})`;
    ctx.lineWidth   = 3 * s + pulse * 2;
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx + 8 + pulse * 6, ry + 3 + pulse * 2, 0, 0, Math.PI * 2); ctx.stroke();

    ctx.save();
    ctx.font      = `bold ${Math.round(11 * s + 1)}px sans-serif`;
    ctx.fillStyle = `rgba(100,190,255,${0.7 + pulse * 0.3})`;
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
    ctx.fillText('VISER + ESPACE', cx2, topY - ry - 13 * s);
    ctx.restore();
  }

  if (state === 'cooking') {
    const prog = Math.min(1, stateT / CFG.COOK_SEC);
    const secs = Math.max(0, Math.ceil(CFG.COOK_SEC - stateT));
    ctx.strokeStyle = '#ff9900';
    ctx.lineWidth   = 4 * s;
    ctx.beginPath();
    ctx.ellipse(cx2, topY, rx * 0.76, ry * 0.76, -Math.PI / 2, 0, Math.PI * 2 * prog);
    ctx.stroke();

    ctx.save();
    ctx.font      = `bold ${Math.round(11 * s)}px sans-serif`;
    ctx.fillStyle = '#ffcc55';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`⏱ ${secs}s`, cx2, topY - ry - 10 * s);
    ctx.restore();
  }

  if (state === 'ready') {
    const urgency = stateT / CFG.REMOVE_SEC;
    const pulse   = 0.5 + 0.5 * Math.sin(Date.now() * 0.016);
    const col     = urgency > 0.55
      ? `rgba(255,90,60,${0.65 + pulse * 0.35})`
      : `rgba(60,230,100,${0.65 + pulse * 0.35})`;
    ctx.strokeStyle = col;
    ctx.lineWidth   = 4 * s + pulse * 2;
    ctx.beginPath(); ctx.ellipse(cx2, topY, rx + 12 + pulse * 8, ry + 4 + pulse * 3, 0, 0, Math.PI * 2); ctx.stroke();

    const secs = Math.max(0, Math.ceil(CFG.REMOVE_SEC - stateT));
    ctx.save();
    ctx.font      = `bold ${Math.round(12 * s)}px sans-serif`;
    ctx.fillStyle = urgency > 0.55 ? '#ff7755' : '#55ff88';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
    ctx.fillText(`🦞 SORTIR ! ${secs}s`, cx2, topY - ry - 13 * s);
    ctx.restore();
  }

  // Flash feedback
  if (flashGood > 0) {
    ctx.fillStyle = `rgba(80,255,120,${flashGood * 0.38})`;
    ctx.beginPath(); ctx.ellipse(cx2, topY + h * 0.3, rx * 1.25, (h + ry) * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (flashBad > 0) {
    ctx.fillStyle = `rgba(255,60,40,${flashBad * 0.38})`;
    ctx.beginPath(); ctx.ellipse(cx2, topY + h * 0.3, rx * 1.25, (h + ry) * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  }
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
    ctx.save();
    ctx.translate(pr.x, pr.y);
    ctx.rotate(pr.ang);
    const sz = pr.sz;
    ctx.drawImage(imgHomard, -sz / 2, -sz / 2, sz, sz);
    ctx.restore();
  }
}

// ── Draw crosshair ────────────────────────────────────────────────────────────
function drawCrosshair() {
  const { x, y } = xh;
  const tgt = pots.find(p => p.hit(x, y) && (p.state === 'boiling' || p.state === 'ready'));
  const col = tgt
    ? (tgt.state === 'ready' ? '#55ff88' : '#55bbff')
    : 'rgba(255,255,255,0.88)';

  ctx.save();
  ctx.strokeStyle = col;
  ctx.shadowColor = '#000';
  ctx.shadowBlur  = 8;

  // Outer ring
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.stroke();

  // Center dot
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();

  // Four lines with gap
  ctx.lineWidth = 2;
  [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * 20, y + dy * 20);
    ctx.lineTo(x + dx * 33, y + dy * 33);
    ctx.stroke();
  });

  if (tgt) {
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(x, y, 23, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ── Draw gauge ────────────────────────────────────────────────────────────────
function drawGauge() {
  const gx = W / 2 - 170, gy = H - 52, gw = 340, gh = 24;

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.70)';
  rrect(gx - 6, gy - 6, gw + 12, gh + 12, 8); ctx.fill();
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();

  // Color fill (blue → red)
  const hue = lerp(220, 0, gVal);
  ctx.fillStyle = `hsl(${hue},88%,52%)`;
  ctx.fillRect(gx, gy, gw * gVal, gh);

  // OK zone
  const zx1 = gx + gw * CFG.G_MIN;
  const zx2 = gx + gw * CFG.G_MAX;
  ctx.fillStyle   = 'rgba(100,255,100,0.22)';
  ctx.fillRect(zx1, gy, zx2 - zx1, gh);
  ctx.strokeStyle = '#55ee55'; ctx.lineWidth = 2;
  ctx.strokeRect(zx1, gy, zx2 - zx1, gh);

  // Needle
  ctx.fillStyle = '#fff';
  ctx.fillRect(gx + gw * gVal - 2, gy - 7, 4, gh + 14);

  ctx.save();
  ctx.font      = '11px sans-serif';
  ctx.fillStyle = '#77ee77';
  ctx.textAlign = 'center';
  ctx.fillText('70%', zx1, gy - 7);
  ctx.fillText('90%', zx2, gy - 7);
  ctx.fillStyle    = '#bbb';
  ctx.textAlign    = 'left';
  ctx.font         = 'bold 12px sans-serif';
  ctx.fillText('⚡ ÉNERGIE', gx, gy - 7);
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  ctx.font      = '11px sans-serif';
  ctx.fillText('[ ESPACE / tap droit ]', W / 2, gy + gh + 16);
  ctx.restore();
}

// ── Draw HUD ──────────────────────────────────────────────────────────────────
function drawHUD() {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  rrect(12, 10, 154, 40, 8); ctx.fill();

  ctx.font         = 'bold 21px Georgia, serif';
  ctx.fillStyle    = '#fff';
  ctx.shadowColor  = '#000';
  ctx.shadowBlur   = 5;
  ctx.textAlign    = 'left';
  ctx.fillText(`🦞 ${score} / ${CFG.WIN}`, 22, 37);

  ctx.textAlign = 'center';
  ctx.font      = '15px sans-serif';
  pots.forEach((p, i) => {
    const icon = { idle: '⬛', boiling: '🔵', cooking: '🟠', flying: '🟠', ready: '🟢' }[p.state] ?? '⬛';
    ctx.fillText(icon, W - 18 - i * 30, 32);
  });
  ctx.restore();
}

// ── Draw welcome ──────────────────────────────────────────────────────────────
function drawWelcome() {
  // Full overlay
  ctx.fillStyle = 'rgba(8,4,0,0.80)';
  ctx.fillRect(0, 0, W, H);

  // Salut lobster (right side)
  if (imgsReady >= 2) {
    ctx.drawImage(imgSalut, W * 0.54, H * 0.38, 265, 200);

    // Speech bubble
    const bx = W * 0.54 + 265 * 0.44;
    const by = H * 0.12;
    const bw = 218, bh = 154;
    ctx.fillStyle = 'rgba(255,252,240,0.97)';
    rrect(bx, by, bw, bh, 14); ctx.fill();
    ctx.strokeStyle = '#cc3300'; ctx.lineWidth = 2.5; ctx.stroke();
    // Tail
    ctx.beginPath();
    ctx.moveTo(bx + 32, by + bh);
    ctx.lineTo(bx + 10, by + bh + 28);
    ctx.lineTo(bx + 62, by + bh);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,252,240,0.97)'; ctx.fill();
    ctx.strokeStyle = '#cc3300'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx + 10, by + bh + 28); ctx.lineTo(bx + 10, by + bh + 1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + 10, by + bh + 28); ctx.lineTo(bx + 62, by + bh + 1); ctx.stroke();
    // Bubble text
    ctx.fillStyle  = '#330000';
    ctx.textAlign  = 'left';
    ctx.font       = 'bold 14px Georgia, serif';
    ['Salut ! Cuit 10 homards', 'pour mériter ton', 'invitation au souper ! 🦞'].forEach((l, i) => {
      ctx.fillText(l, bx + 12, by + 30 + i * 24);
    });
  }

  // Rules card
  const rx = 36, ry = 22, rw = W * 0.47, rh = H * 0.89;
  ctx.fillStyle = 'rgba(16,7,0,0.93)';
  rrect(rx, ry, rw, rh, 16); ctx.fill();
  ctx.strokeStyle = '#cc4d1a'; ctx.lineWidth = 2.5; ctx.stroke();

  ctx.save();
  ctx.textAlign   = 'center';
  ctx.fillStyle   = '#ff9944';
  ctx.font        = 'bold 25px Georgia, serif';
  ctx.shadowColor = '#cc2200'; ctx.shadowBlur = 14;
  ctx.fillText('🦞 Souper Homard 🦞', rx + rw / 2, ry + 46);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#e0d0b0';
  ctx.font      = '14.5px Georgia, serif';
  ctx.textAlign = 'left';
  [
    '🔵 Quand une casserole bout, vise-la.',
    '⚡ Presse ESPACE entre 70 et 90%',
    '   de la jauge pour lancer le homard.',
    '🟠 Le homard cuit pendant 30 secondes.',
    '🟢 Après cuisson, vise + ESPACE',
    '   dans les 10 secondes pour le sortir.',
    '♻️  Les casseroles rebouillent après !',
    '🏆 5 homards réussis = invitation gagnée !',
    '',
    '🖥  Flèches / WASD pour viser, ESPACE',
    '📱 Glisse gauche pour viser, tap droit',
  ].forEach((l, i) => ctx.fillText(l, rx + 18, ry + 82 + i * 30));

  // Start button
  const pulse  = 0.5 + 0.5 * Math.sin(Date.now() * 0.004);
  const btnX   = rx + rw / 2 - 130, btnY = ry + rh - 68, btnW = 260, btnH = 50;
  ctx.fillStyle = `rgba(${Math.round(175 + pulse * 35)},46,12,0.95)`;
  rrect(btnX, btnY, btnW, btnH, 12); ctx.fill();
  ctx.strokeStyle = '#ff7733'; ctx.lineWidth = 2; ctx.stroke();

  ctx.fillStyle  = '#fff';
  ctx.font       = 'bold 16px Georgia, serif';
  ctx.textAlign  = 'center';
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

  if (phase === 'playing') {
    drawCrosshair();
    drawGauge();
    drawHUD();
  }

  if (phase === 'welcome') drawWelcome();

  // Mobile joystick indicator
  if (phase === 'playing' && joyTouch) {
    const { ox, oy, dx, dy } = joyTouch;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(ox, oy, 36, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.arc(ox + dx * 28, oy + dy * 28, 16, 0, Math.PI * 2); ctx.fill();
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min((ts - lastT) / 1000, 0.05);
  lastT = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(ts => { lastT = ts; requestAnimationFrame(loop); });
