/**
 * NEON TETRIS — 렌더링 / 입력 / 게임 루프
 */
(function () {
  'use strict';

  const C = window.TetrisCore;
  const COLS = C.COLS, ROWS = C.ROWS;
  const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

  const DAS = 0.14;        // 지연 후 좌우 반복 시작 (초)
  const ARR = 0.028;       // 좌우 반복 간격
  const SOFT = 0.032;      // 소프트 드롭 간격 상한
  const LOCK = 0.5;        // 락 딜레이
  const MAX_RESETS = 15;   // 락 딜레이 리셋 한도
  const CLEAR_TIME = 0.26; // 줄 삭제 애니메이션
  const MAX_LEVEL = 20;

  /* ================= DOM ================= */
  const $ = function (id) { return document.getElementById(id); };
  const stage = $('stage');
  const slot = stage.parentElement;
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const holdCard = $('holdCard');
  const holdCanvas = $('hold');
  const nextWrap = $('nextWrap');
  const overlay = $('overlay');
  const ovTitle = $('ovTitle'), ovSub = $('ovSub'), ovStats = $('ovStats'), ovBtn = $('ovBtn');
  const scoreEl = $('score'), levelEl = $('level'), linesEl = $('lines'), highEl = $('high');
  const chipsEl = $('chips');
  const statTime = $('statTime'), statPieces = $('statPieces'), statLpm = $('statLpm');
  const statAps = $('statAps'), statTetris = $('statTetris'), statTspin = $('statTspin');

  const previews = [{ el: holdCanvas, ctx: holdCanvas.getContext('2d') }];
  for (let i = 0; i < 5; i++) {
    const c = document.createElement('canvas');
    nextWrap.appendChild(c);
    previews.push({ el: c, ctx: c.getContext('2d') });
  }

  /* ================= 소리 ================= */
  const sfx = {
    ac: null, master: null, muted: false, noiseBuf: null,
    init: function () {
      if (this.ac) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ac = new AC(); } catch (e) { return; }
      this.master = this.ac.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ac.destination);
      const len = Math.floor(this.ac.sampleRate * 0.4);
      this.noiseBuf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    },
    resume: function () {
      this.init();
      if (this.ac && this.ac.state === 'suspended') this.ac.resume();
    },
    tone: function (o) {
      if (!this.ac || this.muted) return;
      const t = this.ac.currentTime + (o.delay || 0);
      const osc = this.ac.createOscillator();
      const g = this.ac.createGain();
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + o.d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.v == null ? 0.28 : o.v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.d);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + o.d + 0.03);
    },
    noise: function (o) {
      if (!this.ac || this.muted || !this.noiseBuf) return;
      const t = this.ac.currentTime + (o.delay || 0);
      const src = this.ac.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = this.ac.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.cut || 1200;
      const g = this.ac.createGain();
      g.gain.setValueAtTime(o.v || 0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (o.d || 0.12));
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + (o.d || 0.12) + 0.02);
    },
    move: function () { this.tone({ f: 190, d: 0.035, v: 0.09, type: 'square' }); },
    rotate: function () { this.tone({ f: 430, f2: 660, d: 0.07, v: 0.16, type: 'triangle' }); },
    hold: function () { this.tone({ f: 320, f2: 480, d: 0.09, v: 0.18, type: 'sine' }); },
    drop: function () { this.noise({ d: 0.1, v: 0.22, cut: 700 }); this.tone({ f: 130, f2: 55, d: 0.1, v: 0.16, type: 'sawtooth' }); },
    lock: function () { this.noise({ d: 0.06, v: 0.13, cut: 950 }); },
    clear: function (n) {
      const notes = [523, 659, 784, 1046];
      for (let i = 0; i < Math.max(2, n + 1); i++) {
        this.tone({ f: notes[i % 4] * (n >= 4 ? 1.5 : 1), d: 0.16, v: 0.14, delay: i * 0.055, type: 'triangle' });
      }
      this.noise({ d: 0.2, v: 0.12, cut: 2600, delay: 0.02 });
    },
    pc: function () {
      [523, 659, 784, 1046, 1318, 1568].forEach(function (f, i) {
        sfx.tone({ f: f, d: 0.28, v: 0.14, delay: i * 0.07, type: 'triangle' });
      });
    },
    level: function () {
      [440, 587, 880].forEach(function (f, i) {
        sfx.tone({ f: f, d: 0.2, v: 0.16, delay: i * 0.09, type: 'sine' });
      });
    },
    over: function () {
      [392, 330, 262, 196].forEach(function (f, i) {
        sfx.tone({ f: f, d: 0.4, v: 0.2, delay: i * 0.16, type: 'triangle' });
      });
    },
  };

  /* ================= 색상/스프라이트 ================= */
  function hex2rgb(h) {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgba(hex, a) {
    const c = hex2rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function shade(hex, amt) {
    const c = hex2rgb(hex);
    const f = function (v) {
      return Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
    };
    return 'rgb(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ')';
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  const sprites = new Map();
  /** 블록 스프라이트 (dpr 해상도로 생성, CSS px 로 그려짐) */
  function sprite(type, size, mode) {
    const key = type + '|' + size + '|' + mode + '|' + dpr;
    if (sprites.has(key)) return sprites.get(key);
    const col = C.COLORS[type];
    const pad = Math.ceil(size * 0.45);
    const box = size + pad * 2;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(box * dpr);
    cv.height = Math.ceil(box * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const x = pad, y = pad, s = size, r = Math.max(2, size * 0.2);

    if (mode === 'ghost') {
      roundRect(g, x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.8, r * 0.7);
      g.fillStyle = rgba(col, 0.07); g.fill();
      g.strokeStyle = rgba(col, 0.42);
      g.lineWidth = Math.max(1.2, s * 0.07);
      g.stroke();
    } else {
      const glow = mode === 'active' ? 1 : 0.38;
      g.shadowColor = rgba(col, 0.8 * glow);
      g.shadowBlur = s * (mode === 'active' ? 0.75 : 0.35);
      g.fillStyle = rgba(col, 0.9);
      roundRect(g, x, y, s, s, r); g.fill();
      g.shadowBlur = 0;

      const grad = g.createLinearGradient(x, y, x + s * 0.35, y + s);
      grad.addColorStop(0, shade(col, 0.35));
      grad.addColorStop(0.5, col);
      grad.addColorStop(1, shade(col, -0.5));
      roundRect(g, x, y, s, s, r);
      g.fillStyle = grad; g.fill();

      // 상단 하이라이트
      roundRect(g, x + s * 0.14, y + s * 0.11, s * 0.72, s * 0.3, r * 0.55);
      g.fillStyle = 'rgba(255,255,255,' + (0.24 + 0.14 * glow) + ')';
      g.fill();

      // 테두리
      roundRect(g, x + 0.7, y + 0.7, s - 1.4, s - 1.4, r * 0.85);
      g.strokeStyle = 'rgba(255,255,255,' + (0.2 + 0.25 * glow) + ')';
      g.lineWidth = Math.max(1, s * 0.055);
      g.stroke();
    }
    cv._pad = pad;
    cv._box = box;
    sprites.set(key, cv);
    return cv;
  }
  function drawCell(g, type, px, py, size, mode) {
    const sp = sprite(type, size, mode);
    g.drawImage(sp, px - sp._pad, py - sp._pad, sp._box, sp._box);
  }

  /* ================= 상태 ================= */
  let dpr = 1, cell = 24;

  const G = {
    state: 'ready',
    prevState: 'ready',
    board: C.createBoard(),
    rand: C.createRandomizer(),
    queue: [],
    piece: null,
    hold: null,
    canHold: true,
    score: 0, lines: 0, level: 1, combo: -1, b2b: false,
    dropTimer: 0, lockTimer: 0, lockResets: 0, lowestY: 0, lastKick: 0, spinFlag: false, lastHard: false,
    pending: null, clearTimer: 0,
    particles: [], popups: [], shake: 0,
    stats: { pieces: 0, tetrises: 0, tspins: 0, pc: 0, time: 0 },
    high: 0,
    highAtStart: 0,
    record: false,
  };
  try { G.high = parseInt(localStorage.getItem('neon-tetris-high') || '0', 10) || 0; } catch (e) { G.high = 0; }

  /* ================= 크기 ================= */
  function resize() {
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const r = slot.getBoundingClientRect();
    const cw = Math.floor((r.width - 4) / COLS);
    const ch = Math.floor((r.height - 4) / ROWS);
    cell = Math.max(9, Math.min(cw, ch));
    const w = cell * COLS, h = cell * ROWS;
    stage.style.width = (w + 2) + 'px';
    stage.style.height = (h + 2) + 'px';
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    sprites.clear();
    previews.forEach(function (p) {
      const b = p.el.getBoundingClientRect();
      p.el.width = Math.max(1, Math.round(b.width * dpr));
      p.el.height = Math.max(1, Math.round(b.height * dpr));
    });
  }

  /* ================= 게임 플로우 ================= */
  function gravityInterval() {
    return Math.max(0.045, Math.pow(0.86, G.level - 1));
  }

  function reset() {
    G.board = C.createBoard();
    G.rand = C.createRandomizer();
    G.queue = [];
    while (G.queue.length < 5) G.queue.push(G.rand.next());
    G.hold = null; G.canHold = true;
    G.score = 0; G.lines = 0; G.level = 1; G.combo = -1; G.b2b = false;
    G.pending = null; G.clearTimer = 0;
    G.particles.length = 0; G.popups.length = 0; G.shake = 0;
    G.stats = { pieces: 0, tetrises: 0, tspins: 0, pc: 0, time: 0 };
    G.dropTimer = 0; G.lockTimer = 0; G.lockResets = 0; G.spinFlag = false;
    held.left = held.right = held.down = false;
    spawn();
    updateHUD();
  }

  function spawn(type) {
    if (!type) {
      type = G.queue.shift();
      G.queue.push(G.rand.next());
    }
    const m = C.STATES[type][0];
    G.piece = {
      type: type,
      rot: 0,
      x: Math.floor((COLS - m[0].length) / 2),
      y: -C.EMPTY_TOP[type],
    };
    G.dropTimer = 0; G.lockTimer = 0; G.lockResets = 0;
    G.spinFlag = false; G.lastKick = 0; G.canHold = true; G.lastHard = false;
    G.lowestY = G.piece.y;
    if (C.collides(G.board, m, G.piece.x, G.piece.y)) {
      G.piece = null;
      gameOver();
      return false;
    }
    return true;
  }

  function matrix() { return C.STATES[G.piece.type][G.piece.rot]; }
  function grounded() { return C.collides(G.board, matrix(), G.piece.x, G.piece.y + 1); }

  function resetLock() {
    if (grounded() && G.lockResets < MAX_RESETS) {
      G.lockTimer = 0;
      G.lockResets++;
    }
  }

  function move(dx) {
    if (!G.piece || G.state !== 'playing') return false;
    if (C.collides(G.board, matrix(), G.piece.x + dx, G.piece.y)) return false;
    G.piece.x += dx;
    G.spinFlag = false;
    resetLock();
    sfx.move();
    return true;
  }

  function rotate(dir) {
    if (!G.piece || G.state !== 'playing' || G.piece.type === 'O') return false;
    const p = G.piece;
    const from = p.rot;
    const to = dir === 2 ? (p.rot + 2) % 4 : (p.rot + (dir > 0 ? 1 : 3)) % 4;
    const table = dir === 2 ? C.KICKS_180 : C.kicksFor(p.type, from, to);
    const m = C.STATES[p.type][to];
    for (let i = 0; i < table.length; i++) {
      if (!C.collides(G.board, m, p.x + table[i][0], p.y + table[i][1])) {
        p.x += table[i][0];
        p.y += table[i][1];
        p.rot = to;
        G.lastKick = i;
        G.spinFlag = true;
        resetLock();
        sfx.rotate();
        return true;
      }
    }
    return false;
  }

  function tryDown(countAsSoft) {
    if (!G.piece || C.collides(G.board, matrix(), G.piece.x, G.piece.y + 1)) return false;
    G.piece.y++;
    G.spinFlag = false;
    if (G.piece.y > G.lowestY) {
      G.lowestY = G.piece.y;
      G.lockResets = 0;
      G.lockTimer = 0;
    }
    if (countAsSoft) G.score += 1;
    return true;
  }

  function hardDrop() {
    if (!G.piece || G.state !== 'playing') return;
    const m = matrix();
    let dist = 0;
    const startY = G.piece.y;
    while (!C.collides(G.board, m, G.piece.x, G.piece.y + 1)) { G.piece.y++; dist++; }
    G.lastHard = true;
    if (dist) {
      G.score += dist * 2;
      // 하드 드롭은 마지막 회전을 유지 → T-스핀 인정
      // 착지 트레일
      const cells = C.cellsOf(G.piece.type, G.piece.rot);
      cells.forEach(function (c) {
        const px = (G.piece.x + c[0] + 0.5) * cell;
        for (let y = startY; y < G.piece.y; y++) {
          if (Math.random() < 0.35) {
            G.particles.push({
              x: px, y: (y + 0.5) * cell, vx: (Math.random() - 0.5) * 40, vy: -Math.random() * 60,
              life: 0.25, max: 0.25, size: cell * 0.16, color: C.COLORS[G.piece.type],
            });
          }
        }
      });
    }
    G.shake = Math.min(7, 1.5 + dist * 0.35);
    sfx.drop();
    lockPiece();
  }

  function holdPiece() {
    if (!G.piece || !G.canHold || (G.state !== 'playing')) return;
    const cur = G.piece.type;
    const stash = G.hold;
    G.hold = cur;
    if (stash) {
      G.piece = null;
      spawn(stash);
    } else {
      G.piece = null;
      spawn();
    }
    G.canHold = false;
    sfx.hold();
  }

  function lockPiece() {
    const p = G.piece;
    if (!p) return;
    const spin = G.spinFlag ? C.tspinKind(G.board, p, G.lastKick) : 'none';

    // 상단 이탈 검사
    let topped = false;
    C.cellsOf(p.type, p.rot).forEach(function (c) {
      if (p.y + c[1] < 0) topped = true;
    });

    C.merge(G.board, p);
    G.piece = null;
    G.stats.pieces++;
    sfx.lock();

    const rows = C.fullRows(G.board);
    const n = rows.length;
    const perfect = n > 0 && C.wouldBePerfect(G.board, rows);

    G.combo = n > 0 ? G.combo + 1 : -1;
    const res = C.scoreClear({
      lines: n, spin: spin, combo: G.combo, level: G.level,
      perfect: perfect, b2b: G.b2b, hardDrop: !!G.lastHard,
    });
    G.score += res.points;

    if (n > 0) {
      if (n === 4) G.stats.tetrises++;
      if (spin !== 'none') G.stats.tspins++;
      if (perfect) G.stats.pc++;
      G.b2b = res.difficult;
    } else if (spin !== 'none') {
      G.stats.tspins++;
    }

    if (res.label) {
      const color = n >= 4 || perfect ? '#ffd83d' : spin !== 'none' ? '#c05bff' : '#35e5f5';
      addPopup(res.label, '+' + res.points.toLocaleString(), color);
    }
    if (perfect) sfx.pc();
    if (G.combo > 0) addPopup('COMBO x' + G.combo, '', '#3ee08f', true);

    if (n > 0) {
      G.state = 'clearing';
      G.pending = { rows: rows, lines: n };
      G.clearTimer = CLEAR_TIME;
      rows.forEach(function (row) {
        for (let x = 0; x < COLS; x++) {
          const t = G.board[row][x] || 'I';
          for (let i = 0; i < 3; i++) {
            G.particles.push({
              x: (x + 0.2 + Math.random() * 0.6) * cell,
              y: (row + 0.2 + Math.random() * 0.6) * cell,
              vx: (Math.random() - 0.5) * 320,
              vy: -Math.random() * 260 - 40,
              life: 0.5 + Math.random() * 0.4,
              max: 0.9,
              size: cell * (0.14 + Math.random() * 0.16),
              color: C.COLORS[t],
            });
          }
        }
      });
      G.shake = Math.max(G.shake, 2 + n * 1.8);
      if (!perfect) sfx.clear(n);
    }

    if (topped) { gameOver(); return; }
    if (n === 0) afterLock();
  }

  function afterLock() {
    if (G.state === 'over') return;
    G.state = 'playing';
    spawn();
  }

  function finalizeClear() {
    C.removeRows(G.board, G.pending.rows);
    G.lines += G.pending.lines;
    const lv = Math.min(MAX_LEVEL, Math.floor(G.lines / 10) + 1);
    if (lv > G.level) {
      G.level = lv;
      sfx.level();
      stage.classList.remove('levelup');
      void stage.offsetWidth;
      stage.classList.add('levelup');
      addPopup('LEVEL ' + G.level, '', '#35e5f5', true);
    }
    G.pending = null;
    afterLock();
    updateHUD();
  }

  function start() {
    G.highAtStart = G.high;
    G.record = false;
    reset();
    G.state = 'playing';
    hideOverlay();
    sfx.resume();
  }

  function togglePause(force) {
    if (G.state === 'playing' || G.state === 'clearing') {
      G.prevState = G.state;
      G.state = 'paused';
      showOverlay('paused');
      held.left = held.right = held.down = false;
    } else if (G.state === 'paused' && !force) {
      G.state = G.prevState === 'clearing' ? 'clearing' : 'playing';
      hideOverlay();
    }
  }

  function gameOver() {
    G.state = 'over';
    G.piece = null;
    if (G.score > G.high) G.high = G.score;
    lastHighSave = 0;
    saveHigh();
    G.shake = 8;
    sfx.over();
    showOverlay('over');
    updateHUD();
  }

  /* ================= 팝업/입력 ================= */
  const held = { left: false, right: false, down: false };
  let dasT = 0, arrT = 0;

  function addPopup(text, sub, color, small) {
    G.popups.push({
      text: text, sub: sub || '', color: color || '#ffffff',
      t: 0, life: small ? 0.8 : 1.15, small: !!small,
    });
    if (G.popups.length > 5) G.popups.shift();
  }

  /* ================= 업데이트 ================= */
  function update(dt) {
    if (G.state === 'playing' || G.state === 'clearing') G.stats.time += dt;

    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 22);

    // 파티클
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.vy += 1500 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    // 팝업
    for (let i = G.popups.length - 1; i >= 0; i--) {
      const q = G.popups[i];
      q.t += dt;
      if (q.t >= q.life) G.popups.splice(i, 1);
    }

    if (G.state === 'clearing') {
      G.clearTimer -= dt;
      if (G.clearTimer <= 0) finalizeClear();
      return;
    }
    if (G.state !== 'playing' || !G.piece) return;

    // 좌우 DAS / ARR
    const dir = (held.left ? -1 : 0) + (held.right ? 1 : 0);
    if (dir !== 0) {
      dasT += dt;
      if (dasT >= DAS) {
        arrT += dt;
        let guard = 0;
        while (arrT >= ARR && guard++ < 12) {
          arrT -= ARR;
          if (!move(dir)) break;
        }
      }
    }

    // 중력
    const gi = gravityInterval();
    const interval = held.down ? Math.min(gi, SOFT) : gi;
    G.dropTimer += dt;
    let guard = 0;
    while (G.dropTimer >= interval && guard++ < 30) {
      G.dropTimer -= interval;
      if (!tryDown(held.down)) { G.dropTimer = 0; break; }
    }

    // 락 딜레이
    if (grounded()) {
      G.lockTimer += dt;
      if (G.lockTimer >= LOCK) lockPiece();
    } else {
      G.lockTimer = 0;
    }
  }

  /* ================= 렌더링 ================= */
  function fieldBg(w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.04)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.008)');
    g.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, h); }
    for (let y = 1; y < ROWS; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(w, y * cell + 0.5); }
    ctx.stroke();

    // 위험 라인
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,92,122,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cell * 4.5); ctx.lineTo(w, cell * 4.5);
    ctx.stroke();
    ctx.restore();
  }

  function stackHeight() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) if (G.board[y][x]) return ROWS - y;
    }
    return 0;
  }

  function drawPreviews() {
    // hold
    const hp = previews[0];
    drawPreview(hp, G.hold, G.canHold);
    for (let i = 0; i < 5; i++) drawPreview(previews[i + 1], G.queue[i], true, i === 0);
  }

  function drawPreview(p, type, enabled, big) {
    const g = p.ctx;
    const w = p.el.width / dpr, h = p.el.height / dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, p.el.width, p.el.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!type) return;
    const box = C.bbox(type, 0);
    const s = Math.floor(Math.min(w / 4.6, h / (big ? 3.1 : 2.6)));
    const px = (w - box.w * s) / 2 - box.minX * s;
    const py = (h - box.h * s) / 2;
    g.globalAlpha = enabled ? 1 : 0.35;
    C.cellsOf(type, 0).forEach(function (c) {
      drawCell(g, type, px + c[0] * s, py + c[1] * s, s, 'stack');
    });
    g.globalAlpha = 1;
  }

  function render() {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (G.shake > 0.05) {
      ctx.translate((Math.random() * 2 - 1) * G.shake, (Math.random() * 2 - 1) * G.shake);
    }

    fieldBg(w, h);

    const clearing = G.state === 'clearing' && G.pending;
    const ct = clearing ? 1 - G.clearTimer / CLEAR_TIME : 0;
    const rowSet = {};
    if (clearing) G.pending.rows.forEach(function (r) { rowSet[r] = true; });

    // 쌓인 블록
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = G.board[y][x];
        if (!t) continue;
        if (rowSet[y]) {
          const sc = 1 - ct * 0.45;
          const off = (cell * (1 - sc)) / 2;
          ctx.globalAlpha = Math.max(0, 1 - ct * 0.9);
          drawCell(ctx, t, x * cell + off, y * cell + off, cell * sc, 'active');
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(255,255,255,' + Math.max(0, 0.85 - ct * 0.85) + ')';
          ctx.fillRect(x * cell, y * cell, cell, cell);
        } else {
          drawCell(ctx, t, x * cell, y * cell, cell, 'stack');
        }
      }
    }

    // 고스트 + 현재 조각
    if (G.piece && (G.state === 'playing' || G.state === 'paused')) {
      let gy = G.piece.y;
      while (!C.collides(G.board, matrix(), G.piece.x, gy + 1)) gy++;
      const cells = C.cellsOf(G.piece.type, G.piece.rot);
      if (gy !== G.piece.y) {
        cells.forEach(function (c) {
          if (gy + c[1] >= 0) drawCell(ctx, G.piece.type, (G.piece.x + c[0]) * cell, (gy + c[1]) * cell, cell, 'ghost');
        });
        // 접지 하이라이트
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        cells.forEach(function (c) {
          ctx.fillRect((G.piece.x + c[0]) * cell, (gy + c[1]) * cell, cell, 2);
        });
      }
      cells.forEach(function (c) {
        const by = G.piece.y + c[1];
        if (by < 0) return;
        drawCell(ctx, G.piece.type, (G.piece.x + c[0]) * cell, by * cell, cell, 'active');
      });
    }

    // 파티클
    G.particles.forEach(function (p) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 * a;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // 팝업
    let py = h * 0.34;
    G.popups.forEach(function (q) {
      const k = q.t / q.life;
      const a = k < 0.15 ? k / 0.15 : k > 0.65 ? Math.max(0, 1 - (k - 0.65) / 0.35) : 1;
      const size = q.small ? cell * 0.72 : cell * 0.95;
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '800 ' + size.toFixed(1) + 'px ' + MONO;
      ctx.shadowColor = q.color;
      ctx.shadowBlur = 22 * a;
      ctx.fillStyle = q.color;
      const yy = py - k * cell * 0.9;
      ctx.fillText(q.text, w / 2, yy);
      if (q.sub) {
        ctx.shadowBlur = 0;
        ctx.font = '700 ' + (size * 0.62).toFixed(1) + 'px ' + MONO;
        ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * a) + ')';
        ctx.fillText(q.sub, w / 2, yy + size * 0.85);
      }
      py -= size * 1.5;
    });
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // 위쪽 위험 글로우
    const sh = stackHeight();
    stage.classList.toggle('danger', sh >= ROWS - 5);
    if (sh >= ROWS - 5) {
      const dg = ctx.createLinearGradient(0, 0, 0, cell * 4);
      const k = 0.14 + 0.08 * Math.sin(performance.now() / 200);
      dg.addColorStop(0, 'rgba(255,92,122,' + k + ')');
      dg.addColorStop(1, 'rgba(255,92,122,0)');
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, w, cell * 4);
    }

    drawPreviews();
    holdCard.classList.toggle('cooling', !G.canHold);
  }

  /* ================= HUD ================= */
  let prevScore = -1, pulseTimer = 0, lastHighSave = 0;
  function saveHigh() {
    const now = performance.now();
    if (now - lastHighSave < 1200) return;
    lastHighSave = now;
    try { localStorage.setItem('neon-tetris-high', String(G.high)); } catch (e) {}
  }
  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function updateHUD() {
    // 최고 점수 실시간 갱신
    if (G.score > G.high) {
      G.high = G.score;
      saveHigh();
    }
    if (!G.record && G.highAtStart > 0 && G.score > G.highAtStart && G.state === 'playing') {
      G.record = true;
      addPopup('NEW RECORD', '', '#ffd83d', true);
      sfx.level();
    }
    scoreEl.textContent = G.score.toLocaleString();
    levelEl.textContent = G.level;
    linesEl.textContent = G.lines;
    highEl.textContent = G.high.toLocaleString();
    statTime.textContent = fmtTime(G.stats.time);
    statPieces.textContent = G.stats.pieces;
    const min = G.stats.time / 60;
    statLpm.textContent = min > 0.02 ? (G.lines / min).toFixed(1) : '0.0';
    statAps.textContent = G.stats.time > 0.5 ? Math.round(G.score / G.stats.time).toLocaleString() : '0';
    statTetris.textContent = G.stats.tetrises;
    statTspin.textContent = G.stats.tspins;

    if (G.score !== prevScore) {
      if (prevScore >= 0) {
        scoreEl.classList.add('pulse');
        pulseTimer = 0.13;
      }
      prevScore = G.score;
    }
    if (pulseTimer > 0) {
      pulseTimer -= 1 / 60;
      if (pulseTimer <= 0) scoreEl.classList.remove('pulse');
    }

    // 칩 (RECORD / B2B / COMBO)
    const want = [];
    if (G.record) want.push('NEW RECORD \u2605');
    if (G.b2b) want.push('B2B \u00d71.5');
    if (G.combo > 0) want.push('COMBO \u00d7' + G.combo);
    const cur = chipsEl.dataset.state || '';
    const key = want.join(',');
    if (key !== cur) {
      chipsEl.dataset.state = key;
      chipsEl.innerHTML = want.map(function (t) {
        return '<span class="chip' + (t.indexOf('COMBO') === 0 ? ' combo' : '') + '">' + t + '</span>';
      }).join('');
    }
  }

  /* ================= 오버레이 ================= */
  function hideOverlay() { overlay.classList.add('hidden'); }
  function showOverlay(kind) {
    let title = '', sub = '', btn = 'START', stats = '';
    if (kind === 'ready') {
      title = 'NEON TETRIS';
      sub = '줄을 지워 점수를 쌓아보세요';
      btn = 'START';
    } else if (kind === 'paused') {
      title = 'PAUSED';
      sub = '일시정지 중';
      btn = 'RESUME';
    } else if (kind === 'over') {
      title = 'GAME OVER';
      sub = G.record ? '★ 새 최고 점수!' : (G.highAtStart === 0 ? '첫 최고 점수 등록!' : '다시 도전해볼까요?');
      btn = 'RETRY';
      stats = [
        ['SCORE', G.score.toLocaleString()],
        ['LEVEL', G.level],
        ['LINES', G.lines],
        ['TIME', fmtTime(G.stats.time)],
        ['TETRIS', G.stats.tetrises],
        ['T-SPIN', G.stats.tspins],
        ['BEST', G.high.toLocaleString()],
      ].map(function (r) { return '<div><i>' + r[0] + '</i>' + r[1] + '</div>'; }).join('');
    }
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    ovStats.innerHTML = stats;
    ovBtn.textContent = btn;
    overlay.classList.remove('hidden');
  }

  /* ================= 입력 ================= */
  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
    ArrowUp: 'cw', x: 'cw', X: 'cw',
    z: 'ccw', Z: 'ccw',
    a: 'flip', A: 'flip',
    ' ': 'drop',
    c: 'hold', C: 'hold', Shift: 'hold',
    p: 'pause', P: 'pause', Escape: 'pause',
    r: 'restart', R: 'restart',
    m: 'mute', M: 'mute',
    Enter: 'start',
  };

  function act(action) {
    switch (action) {
      case 'left': case 'right': case 'down': break;
      case 'cw': rotate(1); break;
      case 'ccw': rotate(-1); break;
      case 'flip': rotate(2); break;
      case 'drop': if (G.state === 'ready') start(); else if (G.state === 'over') start(); else hardDrop(); break;
      case 'hold': holdPiece(); break;
      case 'pause': if (G.state === 'playing' || G.state === 'clearing' || G.state === 'paused') togglePause(); break;
      case 'restart': start(); break;
      case 'start':
        if (G.state === 'ready' || G.state === 'over' || G.state === 'paused') start();
        break;
      case 'mute': toggleMute(); break;
    }
  }

  function toggleMute() {
    sfx.init();
    sfx.muted = !sfx.muted;
    const b = $('muteBtn');
    b.classList.toggle('off', sfx.muted);
    b.textContent = sfx.muted ? '✕' : '♪';
  }

  window.addEventListener('keydown', function (e) {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].indexOf(k) >= 0) e.preventDefault();
    if (e.repeat) return;
    const action = KEYMAP[k];
    if (!action) return;
    sfx.resume();
    if (action === 'left' || action === 'right') {
      held[action] = true;
      dasT = 0; arrT = 0;
      move(action === 'left' ? -1 : 1);
      return;
    }
    if (action === 'down') { held.down = true; G.dropTimer = Math.max(G.dropTimer, SOFT); return; }
    act(action);
  });

  window.addEventListener('keyup', function (e) {
    const action = KEYMAP[e.key];
    if (action === 'left' || action === 'right' || action === 'down') held[action] = false;
  });

  window.addEventListener('blur', function () {
    held.left = held.right = held.down = false;
    if (G.state === 'playing' || G.state === 'clearing') togglePause(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && (G.state === 'playing' || G.state === 'clearing')) togglePause(true);
  });

  ovBtn.addEventListener('click', function () {
    sfx.resume();
    if (G.state === 'paused') togglePause();
    else start();
  });
  $('pauseBtn').addEventListener('click', function () { togglePause(); });
  $('restartBtn').addEventListener('click', function () { sfx.resume(); start(); });
  $('muteBtn').addEventListener('click', toggleMute);

  /* ---------- 터치 ---------- */
  const touchBtns = [
    { label: '◀', act: 'left', repeat: true },
    { label: '▶', act: 'right', repeat: true },
    { label: '⤓', act: 'down', hold: true },
    { label: '⟲', act: 'ccw' },
    { label: '⟳', act: 'cw' },
    { label: 'HOLD', act: 'hold', small: true },
    { label: 'DROP', act: 'drop', small: true },
  ];
  const touchRoot = $('touch');
  touchBtns.forEach(function (b) {
    const el = document.createElement('button');
    el.textContent = b.label;
    if (b.small) el.style.fontSize = '11px';
    let to = null;
    const stop = function () {
      if (to) { clearTimeout(to); to = null; }
      if (b.act === 'left' || b.act === 'right') held[b.act] = false;
      if (b.act === 'down') held.down = false;
    };
    const begin = function (e) {
      e.preventDefault();
      sfx.resume();
      if (G.state === 'ready' || G.state === 'over') { start(); return; }
      if (b.act === 'left' || b.act === 'right') {
        held[b.act] = true; dasT = 0; arrT = 0;
        move(b.act === 'left' ? -1 : 1);
        to = setTimeout(function () { dasT = DAS; }, DAS * 1000);
      } else if (b.act === 'down') {
        held.down = true;
      } else {
        act(b.act);
      }
    };
    el.addEventListener('pointerdown', begin);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
    touchRoot.appendChild(el);
  });
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.body.classList.add('touch-mode');
  }

  /* ================= 루프 ================= */
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    update(dt);
    render();
    updateHUD();
    requestAnimationFrame(frame);
  }

  /* ================= 시작 ================= */
  /* 디버그: index.html?demo 로 열면 콘솔에서 내부 상태 조작 가능 */
  if (location.search.indexOf('debug') >= 0) {
    window.TetrisDebug = {
      G: G, C: C, start: start, spawn: spawn, move: move, rotate: rotate,
      hardDrop: hardDrop, holdPiece: holdPiece, lockPiece: lockPiece,
      togglePause: togglePause, gravityInterval: gravityInterval,
    };
  }

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(slot);
  resize();
  reset();
  showOverlay('ready');
  requestAnimationFrame(function (t) { last = t; resize(); frame(t); });
})();
