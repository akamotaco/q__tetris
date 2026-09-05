/**
 * NEON TETRIS — 클라이언트 (표현/입력/연출)
 *
 * 게임 규칙은 전적으로 engine.js 가owns 한다. 이 파일은
 *   · 60Hz 틱 루프로 엔진을 진행하고
 *   · 입력을 엔진에 넘기면서 **동시에 리플레이로 기록**하고
 *   · 엔진이 내보낸 events 로 연출(파티클·소리·팝업·흔들림)을 만들고
 *   · HUD/보드/공유/리플레이 재생 UI 를 관리한다.
 * 규칙이 여기에 없으므로 "화면에서 본 것"과 "서버가 재계산한 것"이 갈라질 수 없다.
 */
(function () {
  'use strict';
  const C = window.TetrisCore;
  const EN = window.TetrisEngine;
  const RP = window.TetrisReplay;
  const ID = window.TetrisIdentity;
  const CL = window.TetrisClient;
  const L = window.TetrisI18n;

  const COLS = C.COLS, ROWS = C.ROWS;
  const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
  const UI_FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif';

  /* ================= DOM ================= */
  const $ = function (id) { return document.getElementById(id); };
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const slot = document.querySelector('.stage-slot');
  const overlay = $('overlay');
  const ovTitle = $('ovTitle');
  const ovSub = $('ovSub');
  const ovStats = $('ovStats');
  const ovBtn = $('ovBtn');
  const scoreEl = $('score'), levelEl = $('level'), linesEl = $('lines'), highEl = $('high');
  const chipsEl = $('chips');
  const holdCard = $('holdCard');
  const statTime = $('statTime'), statPieces = $('statPieces'), statLpm = $('statLpm');
  const statAps = $('statAps'), statTetris = $('statTetris'), statTspin = $('statTspin');
  const goalEl = $('goal'), goalWrap = $('goalWrap');
  const previews = [];

  (function buildPreviews() {
    const hp = { el: $('hold') };
    hp.ctx = hp.el.getContext('2d');
    previews.push(hp);
    const wrap = $('nextWrap');
    for (let i = 0; i < 5; i++) {
      const cv = document.createElement('canvas');
      cv.className = 'preview' + (i === 0 ? ' big' : '');
      wrap.appendChild(cv);
      const p = { el: cv };
      p.ctx = cv.getContext('2d');
      previews.push(p);
    }
  })();

  /* ================= 소리 ================= */
  const sfx = {
    ctx: null, muted: false, master: null,
    init: function () {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    },
    resume: function () {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone: function (freq, dur, type, vol, slide) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol == null ? 0.2 : vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    },
    noise: function (dur, vol) {
      if (!this.ctx || this.muted) return;
      const len = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const s = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = vol || 0.2;
      s.buffer = buf; s.connect(g); g.connect(this.master);
      s.start();
    },
    move: function () { this.tone(320, 0.03, 'square', 0.05); },
    rotate: function () { this.tone(520, 0.05, 'triangle', 0.09); },
    lock: function () { this.tone(160, 0.06, 'square', 0.11); },
    drop: function () { this.noise(0.09, 0.14); },
    hold: function () { this.tone(420, 0.07, 'sine', 0.12, 1.5); },
    clear: function (n) {
      const base = [0, 480, 560, 640, 780][Math.min(4, n)] || 480;
      for (let i = 0; i < Math.min(4, n); i++) this.tone(base + i * 110, 0.1, 'triangle', 0.14);
      if (n >= 4) this.tone(1180, 0.42, 'sawtooth', 0.11, 0.6);
    },
    pc: function () {
      [523, 659, 784, 1046, 1318].forEach(function (f, i) {
        setTimeout(function () { sfx.tone(f, 0.22, 'triangle', 0.13); }, i * 70);
      });
    },
    level: function () { this.tone(700, 0.14, 'sine', 0.14); this.tone(1046, 0.24, 'sine', 0.1, 1.2); },
    over: function () {
      [420, 330, 250, 170].forEach(function (f, i) {
        setTimeout(function () { sfx.tone(f, 0.24, 'sawtooth', 0.12, 0.7); }, i * 130);
      });
    },
  };

  /* ================= 색상/스프라이트 ================= */
  function hex2rgb(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  function rgba(hex, a) { const c = hex2rgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function shade(hex, amt) {
    const c = hex2rgb(hex);
    const f = function (v) { return Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)); };
    return 'rgb(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ')';
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  const sprites = new Map();
  function sprite(type, size, mode) {
    const key = type + '|' + size + '|' + mode + '|' + dpr;
    if (sprites.has(key)) return sprites.get(key);
    const col = C.COLORS[type];
    const pad = Math.ceil(size * 0.45);
    const box = size + pad * 2;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(box * dpr); cv.height = Math.ceil(box * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const x = pad, y = pad, s = size, r = Math.max(2, size * 0.2);
    if (mode === 'ghost') {
      roundRect(g, x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.8, r * 0.7);
      g.fillStyle = rgba(col, 0.07); g.fill();
      g.strokeStyle = rgba(col, 0.42); g.lineWidth = Math.max(1.2, s * 0.07); g.stroke();
    } else {
      const glow = mode === 'active' ? 1 : 0.38;
      g.shadowColor = rgba(col, 0.8 * glow);
      g.shadowBlur = s * (mode === 'active' ? 0.75 : 0.35);
      g.fillStyle = rgba(col, 0.9);
      roundRect(g, x, y, s, s, r); g.fill();
      g.shadowBlur = 0;
      const grad = g.createLinearGradient(x, y, x + s * 0.35, y + s);
      grad.addColorStop(0, shade(col, 0.35)); grad.addColorStop(0.5, col); grad.addColorStop(1, shade(col, -0.5));
      roundRect(g, x, y, s, s, r); g.fillStyle = grad; g.fill();
      roundRect(g, x + s * 0.14, y + s * 0.11, s * 0.72, s * 0.3, r * 0.55);
      g.fillStyle = 'rgba(255,255,255,' + (0.24 + 0.14 * glow) + ')'; g.fill();
      roundRect(g, x + 0.7, y + 0.7, s - 1.4, s - 1.4, r * 0.85);
      g.strokeStyle = 'rgba(255,255,255,' + (0.2 + 0.25 * glow) + ')';
      g.lineWidth = Math.max(1, s * 0.055); g.stroke();
    }
    cv._pad = pad; cv._box = box;
    sprites.set(key, cv);
    return cv;
  }
  function drawCell(g, type, px, py, size, mode) {
    const sp = sprite(type, size, mode);
    g.drawImage(sp, px - sp._pad, py - sp._pad, sp._box, sp._box);
  }

  /* ================= 상태 ================= */
  let dpr = 1, cell = 24;

  /** G = 엔진 상태의 **화면 미러**(매 프레임 sync) + 화면 전용 연출 상태.
   *  규칙/점수/타이머는 오직 E(엔진)에만 있다. */
  const G = {
    state: 'ready',                 // ready | playing | clearing | over
    board: C.createBoard(),
    piece: null, hold: null, canHold: true, queue: [],
    score: 0, lines: 0, level: 1, combo: -1, b2b: false,
    stats: { pieces: 0, tetrises: 0, tspins: 0, pc: 0, time: 0, maxCombo: 0 },
    pending: null,
    particles: [], popups: [], shake: 0,
    high: 0, highAtStart: 0, record: false,
  };
  try { G.high = parseInt(localStorage.getItem('neon-tetris-high') || '0', 10) || 0; } catch (e) { G.high = 0; }

  let E = null;                 // 엔진 인스턴스
  let paused = false;
  let opts = { mode: 'marathon', level: 1, g20: false };
  let rec = null;               // { seed, inputs: [] } — 녹화 중
  let playb = null;             // 리플레이 재생 상태
  let session = null;           // 서버 세션(시드/넌스)
  let challenge = null;         // {share, ghost, name}
  const URL_P = new URLSearchParams(location.search);

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
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    sprites.clear();
    previews.forEach(function (p) {
      const b = p.el.getBoundingClientRect();
      p.el.width = Math.max(1, Math.round(b.width * dpr));
      p.el.height = Math.max(1, Math.round(b.height * dpr));
    });
  }

  /* ================= 엔진 연결 ================= */
  function sync() {
    if (!E) return;
    const s = E.snapshot();
    G.state = paused ? 'paused' : s.state;
    G.board = E.board;
    G.piece = s.piece;
    G.hold = s.hold; G.canHold = s.canHold; G.queue = s.queue;
    G.score = s.score; G.lines = s.lines; G.level = s.level;
    G.combo = s.combo; G.b2b = s.b2b;
    G.pending = s.pending;
    G.stats = s.stats;
    G.ticks = s.ticks;
  }

  /** 연출 이벤트 → 화면. 엔진은 결정적이어야 하므로 랜덤 파티클 등은 전부 여기서 만든다. */
  function showEvents(evs) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      switch (e.type) {
        case 'move': sfx.move(); break;
        case 'rotate': sfx.rotate(); break;
        case 'hold': sfx.hold(); break;
        case 'lock': sfx.lock(); break;
        case 'harddrop': {
          sfx.drop();
          G.shake = Math.min(7, 1.5 + e.dist * 0.35);
          const col = C.COLORS[e.piece] || '#ffffff';
          for (let i = 0; i < e.cells.length; i++) {
            const cc = e.cells[i];
            const px = (e.x + cc[0] + 0.5) * cell;
            const y0 = Math.max(0, e.fromY + cc[1]);
            const y1 = e.landY + cc[1];
            for (let y = y0; y < y1; y++) {
              if (Math.random() > 0.35) continue;
              G.particles.push({
                x: px, y: (y + 0.5) * cell, vx: (Math.random() - 0.5) * 40, vy: -Math.random() * 60,
                life: 0.25, max: 0.25, size: cell * 0.16, color: col,
              });
            }
          }
          break;
        }
        case 'scored':
          if (e.lines > 0) sfx.clear(e.lines);
          if (e.perfect) sfx.pc();
          break;
        case 'clearing':
          G.shake = Math.max(G.shake, 2 + e.lines * 1.8);
          spawnClearParticles(e.rows);
          break;
        case 'level':
          sfx.level();
          stage.classList.remove('levelup');
          void stage.offsetWidth;
          stage.classList.add('levelup');
          break;
        case 'popup':
          addPopup(e.text, e.sub, e.color, !!e.small);
          break;
        case 'gameover':
          onFinish(e.reason);
          break;
        case 'spawnblocked':
          break;
      }
    }
  }

  function spawnClearParticles(rows) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let x = 0; x < COLS; x++) {
        const t = G.board[row][x] || 'I';
        for (let i = 0; i < 3; i++) {
          G.particles.push({
            x: (x + 0.2 + Math.random() * 0.6) * cell,
            y: (row + 0.2 + Math.random() * 0.6) * cell,
            vx: (Math.random() - 0.5) * 320,
            vy: -Math.random() * 260 - 40,
            life: 0.5 + Math.random() * 0.4, max: 0.9,
            size: cell * (0.14 + Math.random() * 0.16),
            color: C.COLORS[t],
          });
        }
      }
    }
  }

  /* ================= 팝업 ================= */
  function addPopup(text, sub, color, small) {
    G.popups.push({
      text: L ? L.label(text) : text, sub: sub || '', color: color || '#ffffff',
      t: 0, life: small ? 0.8 : 1.15, small: !!small,
    });
    if (G.popups.length > 5) G.popups.shift();
  }

  /* ================= 입력 ================= */
  const held = { left: false, right: false, down: false };
  const ACT = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'cw', x: 'cw', X: 'cw', z: 'ccw', Z: 'ccw', a: 'flip', A: 'flip', ' ': 'hard', c: 'hold', C: 'hold', Shift: 'hold' };

  /** 입력 하나 = 엔진에 전달 + 리플레이에 기록(같은 틱에 적용됨). 재생 중에는 기록하지 않는다. */
  function send(action, kind) {
    if (!E || paused || G.state === 'ready' || G.state === 'over') return;
    if (rec && kind !== undefined) rec.inputs.push({ t: E.ticks + 1, a: action, k: kind });
    if (kind === 0) E.release(action); else E.press(action);
  }

  function pressKey(action) {
    if (action === 'left' || action === 'right') {
      held[action] = true;
      held[action === 'left' ? 'right' : 'left'] = false;
      send(action, 1);
      return;
    }
    if (action === 'down') { held.down = true; send('down', 1); return; }
    if (action === 'hard') {
      if (G.state === 'ready' || G.state === 'over') { start(); return; }
      send('hard', 1); return;
    }
    if (action === 'hold') { send('hold', 1); return; }
    send(action, 1);
  }
  function releaseKey(action) {
    if (action === 'left' || action === 'right' || action === 'down') {
      if (!held[action]) return;
      held[action] = false;
      send(action, 0);
    }
  }
  function releaseAll() {
    ['left', 'right', 'down'].forEach(function (a) {
      if (held[a]) { held[a] = false; send(a, 0); }
    });
  }

  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
    ArrowUp: 'cw', x: 'cw', X: 'cw', z: 'ccw', Z: 'ccw', a: 'flip', A: 'flip',
    ' ': 'hard', c: 'hold', C: 'hold', Shift: 'hold',
    p: 'pause', P: 'pause', Escape: 'pause',
    r: 'restart', R: 'restart', m: 'mute', M: 'mute', Enter: 'start',
  };

  window.addEventListener('keydown', function (e) {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].indexOf(k) >= 0) e.preventDefault();
    if (e.repeat) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const action = KEYMAP[k];
    if (!action) return;
    sfx.resume();
    if (action === 'pause') { togglePause(); return; }
    if (action === 'restart') { start(); return; }
    if (action === 'mute') { toggleMute(); return; }
    if (action === 'start') {
      if (G.state === 'ready' || G.state === 'over' || paused) start();
      return;
    }
    if (G.state === 'ready') { start(); }
    pressKey(action);
  });
  window.addEventListener('keyup', function (e) {
    const a = ACT[e.key];
    if (a) releaseKey(a);
  });
  window.addEventListener('blur', function () {
    releaseAll();
    if (G.state === 'playing' || G.state === 'clearing') setPause(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { releaseAll(); if (G.state === 'playing' || G.state === 'clearing') setPause(true); }
  });

  /* ================= 게임 플로우 ================= */
  function localSeed() {
    let s = '';
    const b = new Uint8Array(9);
    (window.crypto || window.msCrypto).getRandomValues(b);
    for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(36)).slice(-2);
    return s.replace(/[^0-9a-z]/g, '') || String(Date.now());
  }

  function engineFor(seed) {
    E = EN.create({ seed: seed, mode: opts.mode, level: opts.level, g20: opts.g20 });
    rec = { seed: seed, mode: opts.mode, level: opts.level, g20: opts.g20, startedAt: Date.now(), inputs: [] };
    playb = null;
    paused = false;
    G.particles.length = 0; G.popups.length = 0; G.shake = 0;
    G.record = false; G.highAtStart = G.high;
    sync();
    E.drainEvents();
  }

  /** 서버 세션(1회용 시드) 발급 → 실패하면 오프라인 판 (기록 제출만 비활성) */
  async function start() {
    if (playb) { stopPlayback(); }
    hideOverlay();
    sfx.resume();
    const sess = await CL.session(opts);
    session = sess;
    engineFor(sess ? sess.seed : localSeed());
    updateGoal();
    updateHUD();
  }

  function setPause(v) {
    if (!E || G.state === 'over' || G.state === 'ready') return;
    paused = v;
    releaseAll();
    sync();
    if (paused) showOverlay('paused'); else hideOverlay();
  }
  function togglePause() {
    if (playb) { playb.paused = !playb.paused; return; }
    if (G.state === 'ready' || G.state === 'over') return;
    setPause(!paused);
  }

  /** 판 종료 → 리플레이 생성 → 제출 UI */
  function onFinish(reason) {
    releaseAll();
    sync();
    if (G.score > G.high) { G.high = G.score; saveHigh(true); }
    if (playb) return;                    // 재생 중이면 제출하지 않음
    sfx.over();
    const packed = RP.pack({
      mode: rec.mode, level: rec.level, g20: rec.g20, seed: rec.seed,
      ticks: E.ticks, score: E.score, lines: E.lines, pieces: E.pieces, hash: E.boardHash(),
      inputs: rec.inputs,
    });
    G.lastPacked = packed;
    G.lastReason = reason;
    CL.rememberLocal(rec, packed, E.result());
    showOverlay('over');
    CL.onSubmitReady({
      packed: packed, result: E.result(), session: session,
      challengeOf: challenge ? challenge.share : null,
      box: $('submitBox'),
    });
  }

  /* ================= 리플레이 재생 / 도전 ================= */
  async function startPlayback(share, autoplay) {
    const data = await CL.getReplay(share);
    if (!data) { showOverlay('ready'); return; }
    const rep = RP.unpack(data.replay);
    E = EN.create({ seed: rep.seed, mode: rep.mode, level: rep.level, g20: rep.g20 });
    rec = null;
    paused = false;
    G.particles.length = 0; G.popups.length = 0; G.shake = 0;
    playb = {
      share: share, rep: rep, data: data, cursor: RP.cursor(rep), speed: 1,
      paused: autoplay === false, total: rep.ticks,
    };
    hideOverlay();
    CL.showReplayBar(playb, {
      onSeek: function (tick) { seekTo(tick); },
      onSpeed: function (s) { playb.speed = s; },
      onExit: function () { stopPlayback(); },
      onRestart: function () { seekTo(0); },
    });
    CL.playbackPing(share);
    updateGoal(data);
    updateHUD();
  }

  function seekTo(tick) {
    if (!playb) return;
    // 처음부터 다시 계산(결정적이라 이 방법이 가장 단순하고 정확하다)
    E = EN.create({ seed: playb.rep.seed, mode: playb.rep.mode, level: playb.rep.level, g20: playb.rep.g20 });
    playb.cursor = RP.cursor(playb.rep);
    G.particles.length = 0; G.popups.length = 0;
    let guard = 0;
    while (E.ticks < tick && E.state !== 'over' && guard++ < 2000000) {
      E.setBuffer(playb.cursor.take(E.ticks + 1));
      E.tick();
      E.drainEvents();                       // 되감기 중 연출은 버린다
    }
    playb.paused = false;
    sync();
  }

  function stopPlayback() {
    playb = null;
    CL.hideReplayBar();
    opts = { mode: 'marathon', level: 1, g20: false };
    E = null; rec = null;
    G.state = 'ready';
    showOverlay('ready');
  }

  /** 도전: 상대 기록과 같은 보드 설정으로 새 판 + 고스트 레이스 */
  async function startChallenge(share) {
    const data = await CL.getReplay(share);
    if (!data) return;
    challenge = { share: share, ghost: data.ghost || [], name: data.displayName || data.codename || '?', board: data.board };
    opts = { mode: data.mode, level: data.level, g20: data.g20 };
    CL.showRaceBar(challenge);
    await start();
  }

  /* ================= 루프 ================= */
  let last = performance.now(), acc = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;          // 프레임이 밀려도 게임 시간을 버리지 않는다

    visuals(dt);

    if (E && (paused ? false : true) && (playb ? !playb.paused : G.state !== 'ready')) {
      acc += dt * (playb ? playb.speed : 1);
      let guard = 0;
      while (acc >= EN.TICK && guard++ < 24) {
        acc -= EN.TICK;
        if (playb) E.setBuffer(playb.cursor.take(E.ticks + 1));
        E.tick();
        showEvents(E.drainEvents());
        if (playb && E.state === 'over') { playb.paused = true; CL.replayFinished(); }
      }
      if (challenge && E) CL.updateRace(E);          // 도전 중이면 매 프레임 고스트와 비교
      sync();
      if (playb) CL.updateProgress(E.ticks / Math.max(1, playb.total));
      updateHUD();
    }
    render();
    requestAnimationFrame(frame);
  }

  function visuals(dt) {
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 22);
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.vy += 1500 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = G.popups.length - 1; i >= 0; i--) {
      const q = G.popups[i];
      q.t += dt;
      if (q.t >= q.life) G.popups.splice(i, 1);
    }
  }

  /* ================= 렌더링 ================= */
  function fieldBg(w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.04)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.008)');
    g.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, h); }
    for (let y = 1; y < ROWS; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(w, y * cell + 0.5); }
    ctx.stroke();

    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,92,122,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cell * 4.5); ctx.lineTo(w, cell * 4.5); ctx.stroke();
    ctx.restore();
  }

  function stackHeight() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) if (G.board[y][x]) return ROWS - y;
    }
    return 0;
  }

  function drawPreviews() {
    drawPreview(previews[0], G.hold, G.canHold);
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
    C.cellsOf(type, 0).forEach(function (c) { drawCell(g, type, px + c[0] * s, py + c[1] * s, s, 'stack'); });
    g.globalAlpha = 1;
  }

  function render() {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (G.shake > 0.05) ctx.translate((Math.random() * 2 - 1) * G.shake, (Math.random() * 2 - 1) * G.shake);

    fieldBg(w, h);

    const clearing = G.state === 'clearing' && G.pending;
    const ct = clearing ? 1 - (E ? E.clearT : 0) / EN.CLEAR_TICKS : 0;
    const rowSet = {};
    if (clearing) G.pending.rows.forEach(function (r) { rowSet[r] = true; });

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

    if (G.piece && (G.state === 'playing' || G.state === 'paused')) {
      const gy = E.ghostY();
      const cells = C.cellsOf(G.piece.type, G.piece.rot);
      if (gy !== G.piece.y) {
        cells.forEach(function (c) {
          if (gy + c[1] >= 0) drawCell(ctx, G.piece.type, (G.piece.x + c[0]) * cell, (gy + c[1]) * cell, cell, 'ghost');
        });
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        cells.forEach(function (c) { ctx.fillRect((G.piece.x + c[0]) * cell, (gy + c[1]) * cell, cell, 2); });
      }
      cells.forEach(function (c) {
        const by = G.piece.y + c[1];
        if (by < 0) return;
        drawCell(ctx, G.piece.type, (G.piece.x + c[0]) * cell, by * cell, cell, 'active');
      });
    }

    G.particles.forEach(function (p) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8 * a;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    let py = h * 0.34;
    G.popups.forEach(function (q) {
      const k = q.t / q.life;
      const a = k < 0.15 ? k / 0.15 : k > 0.65 ? Math.max(0, 1 - (k - 0.65) / 0.35) : 1;
      const size = q.small ? cell * 0.72 : cell * 0.95;
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '800 ' + size.toFixed(1) + 'px ' + MONO;
      ctx.shadowColor = q.color; ctx.shadowBlur = 22 * a;
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
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    const sh = stackHeight();
    stage.classList.toggle('danger', sh >= ROWS - 5);
    if (sh >= ROWS - 5) {
      const dg = ctx.createLinearGradient(0, 0, 0, cell * 4);
      const k = 0.14 + 0.08 * Math.sin(performance.now() / 200);
      dg.addColorStop(0, 'rgba(255,92,122,' + k + ')');
      dg.addColorStop(1, 'rgba(255,92,122,0)');
      ctx.fillStyle = dg; ctx.fillRect(0, 0, w, cell * 4);
    }

    drawPreviews();
    holdCard.classList.toggle('cooling', !G.canHold);
  }

  /* ================= HUD ================= */
  let prevScore = -1, pulseTimer = 0, lastHighSave = 0;
  function saveHigh(force) {
    const t = performance.now();
    if (!force && t - lastHighSave < 1200) return;
    lastHighSave = t;
    try { localStorage.setItem('neon-tetris-high', String(G.high)); } catch (e) { }
  }
  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtTicks(ticks) { return fmtTime(ticks * EN.TICK); }

  function updateGoal(data) {
    const M = EN.MODES[opts.mode];
    const src = data ? data : null;
    if (!M) return;
    if (M.targetLines) {
      goalWrap.style.display = '';
      goalEl.textContent = Math.min(M.targetLines, G.lines) + ' / ' + M.targetLines + ' L';
    } else if (M.timeLimit) {
      goalWrap.style.display = '';
      const left = Math.max(0, (M.timeLimit - (src ? src.ticks : (E ? E.ticks : 0))) * EN.TICK);
      goalEl.textContent = (L ? L.t('ultra.left') : '남은 시간') + ' ' + fmtTime(left);
    } else {
      goalWrap.style.display = 'none';
    }
  }

  function updateHUD() {
    if (G.score > G.high) { G.high = G.score; saveHigh(); }
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
    updateGoal();

    if (G.score !== prevScore) {
      if (prevScore >= 0) { scoreEl.classList.add('pulse'); pulseTimer = 0.13; }
      prevScore = G.score;
    }
    if (pulseTimer > 0) {
      pulseTimer -= 1 / 60;
      if (pulseTimer <= 0) scoreEl.classList.remove('pulse');
    }

    const want = [];
    if (G.record) want.push('NEW RECORD ★');
    if (G.b2b) want.push('B2B ×1.5');
    if (G.combo > 0) want.push('COMBO ×' + G.combo);
    const key = want.join(',');
    if (key !== (chipsEl.dataset.state || '')) {
      chipsEl.dataset.state = key;
      chipsEl.innerHTML = want.map(function (t) {
        return '<span class="chip' + (t.indexOf('COMBO') === 0 ? ' combo' : '') + '">' + t + '</span>';
      }).join('');
    }
  }

  /* ================= 오버레이 ================= */
  function hideOverlay() { overlay.classList.add('hidden'); }
  function showOverlay(kind) {
    let title = '', sub = '', btn = L ? L.t('ui.start') : 'START', stats = '';
    if (kind === 'ready') {
      title = 'NEON TETRIS';
      sub = L ? L.t('ov.ready') : '';
      btn = L ? L.t('ui.start') : 'START';
    } else if (kind === 'paused') {
      title = 'PAUSED';
      sub = L ? L.t('ov.paused') : '';
      btn = L ? L.t('ui.resume') : 'RESUME';
    } else if (kind === 'over') {
      title = L ? L.t('ov.over') : 'GAME OVER';
      sub = G.record ? (L ? L.t('ov.newbest') : '') : (G.highAtStart === 0 ? (L ? L.t('ov.firstbest') : '') : (L ? L.t('ov.retry') : ''));
      btn = L ? L.t('ui.retry') : 'RETRY';
      stats = [
        ['SCORE', G.score.toLocaleString()],
        ['LEVEL', G.level],
        ['LINES', G.lines],
        ['TIME', fmtTicks(E ? E.ticks : 0)],
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

  /* ================= 버튼/터치 ================= */
  function toggleMute() {
    sfx.init();
    sfx.muted = !sfx.muted;
    const b = $('muteBtn');
    b.classList.toggle('off', sfx.muted);
    b.textContent = sfx.muted ? '✕' : '♪';
  }
  ovBtn.addEventListener('click', function () {
    sfx.resume();
    if (paused) setPause(false);
    else if (G.state === 'ready' || G.state === 'over') start();
  });
  $('pauseBtn').addEventListener('click', function () { togglePause(); });
  $('restartBtn').addEventListener('click', function () { sfx.resume(); start(); });
  $('muteBtn').addEventListener('click', toggleMute);

  const touchBtns = [
    { label: '◀', act: 'left', hold: true },
    { label: '▶', act: 'right', hold: true },
    { label: '⤓', act: 'down', hold: true },
    { label: '⟲', act: 'ccw' },
    { label: '⟳', act: 'cw' },
    { label: 'HOLD', act: 'hold', small: true },
    { label: 'DROP', act: 'hard', small: true },
  ];
  (function buildTouch() {
    const root = $('touch');
    touchBtns.forEach(function (b) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.small) el.classList.add('txt');
      el.setAttribute('aria-label', b.act);
      const stop = function (e) { e.preventDefault(); if (b.hold) releaseKey(b.act); };
      const begin = function (e) {
        e.preventDefault();
        sfx.resume();
        if (G.state === 'ready' || G.state === 'over') { start(); return; }
        if (paused) { setPause(false); return; }
        pressKey(b.act);
      };
      el.addEventListener('pointerdown', begin);
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointerleave', stop);
      el.addEventListener('pointercancel', stop);
      root.appendChild(el);
    });
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch-mode');
  })();

  /* ================= 모드 선택 ================= */
  function renderModes() {
    const wrap = $('modeChips');
    if (!wrap) return;
    wrap.innerHTML = Object.keys(EN.MODES).map(function (m) {
      return '<button class="mode' + (opts.mode === m ? ' on' : '') + '" data-m="' + m + '">' +
        (L ? L.t('mode.' + m) : EN.MODES[m].name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(wrap.children, function (el) {
      el.addEventListener('click', function () {
        opts.mode = el.dataset.m;
        renderModes();
        updateGoal();
        try { localStorage.setItem('neon-tetris-mode', opts.mode); } catch (e) { }
      });
    });
    const lv = $('levelSel');
    if (lv) {
      lv.value = String(opts.level);
      const g20 = $('g20Chk');
      if (g20) g20.checked = opts.g20;
    }
  }
  (function bindSettings() {
    const lv = $('levelSel'), g20 = $('g20Chk');
    if (lv) {
      for (let i = 1; i <= EN.MAX_LEVEL; i++) {
        const o = document.createElement('option');
        o.value = String(i); o.textContent = 'Lv ' + i;
        lv.appendChild(o);
      }
      lv.addEventListener('change', function () {
        opts.level = Math.max(1, Math.min(EN.MAX_LEVEL, parseInt(lv.value, 10) || 1));
      });
    }
    if (g20) g20.addEventListener('change', function () { opts.g20 = !!g20.checked; });
    try {
      const m = localStorage.getItem('neon-tetris-mode');
      if (m && EN.MODES[m]) opts.mode = m;
    } catch (e) { }
  })();

  /* ================= 디버그/자동화 ================= */
  /**
   * 테스트 하네스(probe.js)가 화면 상태 G 를 직접 읽고 쓰듯 엔진을 조작할 수 있게
   * 엔진 소유 필드는 그대로 엔진으로 통과시키는 프록시를 제공한다.
   * 이렇게 하지 않으면 "G 에 써놓고 화면은 안 바뀌어" 같은 테스트 함정이 생긴다.
   */
  const ENGINE_KEYS = ['board', 'piece', 'hold', 'canHold', 'queue', 'score', 'lines', 'level', 'startLevel',
    'combo', 'b2b', 'pending', 'clearT', 'spinFlag', 'lastKick', 'ticks', 'pieces', 'tetrises', 'tspins',
    'pcs', 'maxCombo', 'lockT', 'lockResets', 'held', 'das', 'arr', 'g20', 'seed', 'mode'];
  const GDebug = new Proxy(G, {
    get: function (t, k) {
      if (k === 'stats') {
        return E ? { pieces: E.pieces, tetrises: E.tetrises, tspins: E.tspins, pc: E.pcs, time: E.ticks * EN.TICK } : t.stats;
      }
      if (k === 'state') return paused ? 'paused' : (E ? E.state : t.state);
      if (E && ENGINE_KEYS.indexOf(k) >= 0) return E[k];
      return t[k];
    },
    set: function (t, k, v) {
      if (k === 'state' && v !== 'paused' && paused) { setPause(false); return true; }
      if (E && ENGINE_KEYS.indexOf(k) >= 0) { E[k] = v; return true; }
      t[k] = v;
      return true;
    },
  });

  if (URL_P.has('debug')) {
    window.TetrisDebug = {
      G: GDebug, GV: G, C: C, EN: EN, RP: RP,
      get engine() { return E; },
      start: function () { return start(); },
      spawn: function (type) { if (E) { E.piece = null; E.spawn(type || null); showEvents(E.drainEvents()); sync(); } return true; },
      move: function (dx) { const ok = E && E.move(dx); if (E) showEvents(E.drainEvents()); sync(); return ok; },
      rotate: function (dir) { const ok = E && E.rotate(dir); if (E) showEvents(E.drainEvents()); sync(); return ok; },
      hardDrop: function () { if (E) { E.hardDrop(); showEvents(E.drainEvents()); sync(); } },
      holdPiece: function () { if (E) { E.holdPiece(); showEvents(E.drainEvents()); sync(); } },
      lockPiece: function () { if (E) { E.lockPiece(); showEvents(E.drainEvents()); sync(); } },
      tick: function (n) { for (let i = 0; i < (n || 1); i++) { if (!E) return; E.tick(); showEvents(E.drainEvents()); } sync(); },
      togglePause: function () { togglePause(); },
      setOpts: function (o) { Object.assign(opts, o); renderModes(); },
      pressKey: function (a) { pressKey(a); },
      releaseKey: function (a) { releaseKey(a); },
      replay: function (share) { return startPlayback(share, true); },
      challenge: function (share) { return startChallenge(share); },
      packed: function () { return G.lastPacked; },
    };
  }

  /* ================= 시작 ================= */
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(slot);
  resize();
  renderModes();
  updateHUD();

  (async function boot() {
    await CL.init({ levelSel: 'levelSel', modes: opts });
    const share = URL_P.get('r') || URL_P.get('replay') || CL.pathShare();
    const chal = URL_P.get('challenge') || URL_P.get('c');
    if (share) {
      await startPlayback(share, true);
    } else if (chal) {
      await startChallenge(chal);
    } else {
      showOverlay('ready');
    }
    CL.mount({ opts: opts, restart: function () { start(); }, challenge: startChallenge, replay: function (s) { return startPlayback(s, true); } });
    requestAnimationFrame(function (t) { last = t; resize(); frame(t); });
  })();
})();
