/**
 * NEON TETRIS — 플레이 가능 AI (테스트/자동화/연습 상대 공용)
 *
 * 엔진의 public 입력 API(press/release)만 사용한다. 사람과 똑같은 경로로 조작하므로
 * 만들어지는 입력 목록이 곧 리플레이가 된다 → 검증 시스템의 회귀 테스트 자료로 사용.
 *
 * 평가: 집계 높이 / 구멍 / 요철 / 완성 줄 / 문지방(row transition) 가중치.
 * skill 로 반응 지연·연타 간격을 조절해 " 초인적 리플레이" 와 "인간급 리플레이" 를 모두 만든다.
 */
(function (root, factory) {
  const hasReq = typeof module !== 'undefined' && module.exports;
  const C = hasReq ? require('../core.js') : root.TetrisCore;
  const EN = hasReq ? require('../engine.js') : root.TetrisEngine;
  const RP = hasReq ? require('../replay.js') : root.TetrisReplay;
  const api = factory(C, EN, RP);
  if (hasReq) module.exports = api;
  else root.TetrisAI = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C, EN, RP) {
  'use strict';

  const W = { height: -0.51, lines: 0.76, holes: -0.36, bump: -0.18, transit: -0.36, topOut: -1000 };

  /* 지표는 **보이는 판** 기준으로만 계산한다 (버퍼 행은 "아직 내려오지 않은 곳"이라 높이/홀에 넣지 않는다). */
  function heightsOf(board) {
    const h = new Array(C.COLS).fill(0);
    for (let x = 0; x < C.COLS; x++) {
      for (let y = C.TOP; y < C.HEIGHT; y++) {
        if (board[y][x]) { h[x] = C.HEIGHT - y; break; }
      }
    }
    return h;
  }

  function countHoles(board) {
    let holes = 0;
    for (let x = 0; x < C.COLS; x++) {
      let seen = false;
      for (let y = C.TOP; y < C.HEIGHT; y++) {
        if (board[y][x]) seen = true;
        else if (seen) holes++;
      }
    }
    return holes;
  }

  /** 놓을 수 있는 모든 (rot, x) 위치를 점수화 */
  function evaluations(board, type) {
    const out = [];
    const rots = type === 'O' ? [0] : type === 'I' ? [0, 1] : [0, 1, 2, 3];
    for (let ri = 0; ri < rots.length; ri++) {
      const rot = rots[ri];
      const m = C.STATES[type][rot];
      for (let x = -(m[0].length - 1); x <= C.COLS - 1; x++) {
        let y = 0;                                    // 배열 맨 위(버퍼 천장 아래)에서 시작
        if (C.collides(board, m, x, y)) continue;
        while (!C.collides(board, m, x, y + 1)) y++;
        if (C.collides(board, m, x, y)) continue;          // 놓을 자리 없음
        const nb = board.map(function (r) { return r.slice(); });
        let floated = false;                          // 버퍼 천장 밖에 걸치는 자리 = 놓을 수 없다
        C.cellsOf(type, rot).forEach(function (c) {
          const by = y + c[1], bx = x + c[0];
          if (by < 0) { floated = true; return; }
          nb[by][bx] = type;
        });
        if (floated) continue;
        const rows = C.fullRows(nb);
        if (rows.length) C.removeRows(nb, rows);
        const h = heightsOf(nb);
        const agg = h.reduce(function (a, b) { return a + b; }, 0);
        const bump = h.reduce(function (a, b, i) { return i ? a + Math.abs(b - h[i - 1]) : a; }, 0);
        let transit = 0;
        for (let cx = 0; cx < C.COLS; cx++) {
          let on = false;
          for (let cy = C.HEIGHT - 1; cy >= C.TOP; cy--) {
            if (nb[cy][cx]) { if (on) transit++; } else on = false;
          }
        }
        let score = W.height * agg + W.lines * rows.length * rows.length +
          W.holes * countHoles(nb) + W.bump * bump + W.transit * transit;
        if (agg > C.COLS * (C.ROWS - 4)) score += W.topOut;
        out.push({ rot: rot, x: x, score: score, lines: rows.length, agg: agg });
      }
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /** 시드된 [0,1) 난수 — 테스트 재현성을 위해 (Math.random 대신 주입) */
  function makeRand(seedText) {
    const r = EN.makeRng(seedText);
    return function () { return r.u32() / 4294967296; };
  }

  const PRESETS = {
    bot: { delay: 0, gap: 1 },                                        // 초인적 (플래그되어야 정상)
    ace: { delay: 3, gap: 2 },                                        // 최상위권(세계신 수준)
    human: { delay: 8, gap: 5, jitter: 0.25 },                        // 숙련 플레이어
    casual: { delay: 16, gap: 9, jitter: 0.45, blunder: 0.06 },       // 일반인
  };

  /**
   * @param {object|string} skill 프리셋 이름 또는 {delay,gap,jitter,blunder,rng}
   */
  function create(skill) {
    if (typeof skill === 'string') skill = PRESETS[skill] || {};
    skill = skill || {};
    const delay = skill.delay == null ? 6 : skill.delay;
    const gap = skill.gap == null ? 3 : skill.gap;
    const jitter = skill.jitter == null ? 0 : skill.jitter;
    const blunder = skill.blunder == null ? 0 : skill.blunder;
    const rand = skill.rng || Math.random;

    let lastAct = -999, target = null, targetPiece = null, release = null;
    let spawnTick = -999, holdDir = 0, holdFor = 0, planned = false;

    /** 이번 틱에 보낼 입력 배열 (다음 틱 경계에서 적용됨) */
    function act(eng) {
      const t = eng.ticks;
      const p = eng.piece;
      if (eng.state !== 'playing' || !p) { holdDir = 0; release = null; return []; }

      if (targetPiece !== p) {                       // 새 조각 → 계획 세우기
        targetPiece = p;
        const ev = evaluations(eng.board, p.type);
        target = ev.length ? ev[0] : null;
        if (target && blunder > 0 && ev.length > 1 && rand() < blunder) {
          target = ev[Math.min(ev.length - 1, 1 + Math.floor(rand() * 3))];   // 실수 재현
        }
        planned = false;
        spawnTick = t;
        holdDir = 0;
        release = null;
      }
      if (!target) return [];
      if (!planned) {
        if (t - spawnTick < delay) return [];        // 반응 지연
        planned = true;
      }

      // 눌러둔 키 놓기는 항상 최우선 (안 놓으면 벽에 들러붙는다)
      if (release && t >= release.t) {
        const a = release.a; release = null;
        return [{ k: 0, a: a }];
      }
      if (t - lastAct < gap) return [];
      if (jitter > 0 && rand() < jitter) return [];

      // 1) 회전 정렬 — 움직이는 중이면 먼저 놓는다
      if (p.rot !== target.rot) {
        if (holdDir) {
          const want = holdDir < 0 ? 'left' : 'right';
          holdDir = 0;
          return [{ k: 0, a: want }];
        }
        const diff = (target.rot - p.rot + 4) % 4;
        lastAct = t;
        return [{ k: 1, a: diff === 1 ? 'cw' : diff === 3 ? 'ccw' : diff === 2 ? 'flip' : 'cw' }];
      }

      // 2) 좌우 정렬 — 방향키를 눌러 미는 식(DAS) / 1칸은 탭
      const dx = target.x - p.x;
      if (holdDir) {
        const want = holdDir < 0 ? 'left' : 'right';
        holdFor++;
        const arrived = dx === 0 || (dx < 0) !== (holdDir < 0);
        if (arrived || holdFor > 90) {
          holdDir = 0;
          return [{ k: 0, a: want }];
        }
        return [];                                    // 계속 누르는 중
      }
      if (dx !== 0) {
        const a = dx < 0 ? 'left' : 'right';
        lastAct = t;
        if (Math.abs(dx) === 1) release = { t: t + 1, a: a };
        else { holdDir = dx < 0 ? -1 : 1; holdFor = 0; }
        return [{ k: 1, a: a }];
      }

      // 3) 하드 드롭
      lastAct = t;
      return [{ k: 1, a: 'hard' }];
    }

    return { act: act, evaluations: evaluations };
  }

  /** AI로 한 판 완주 → 서버 검증에 바로 넣을 수 있는 리플레이 객체 */
  function run(o) {
    o = o || {};
    const eng = EN.create({
      seed: o.seed || 'seed-' + Math.floor(Math.random() * 1e9),
      mode: o.mode, level: o.level, g20: o.g20,
    });
    let skill = o.skill || o.preset;
    if (typeof skill === 'string') skill = Object.assign({}, PRESETS[skill] || {});
    else if (skill) skill = Object.assign({}, skill);
    if (o.rng) skill.rng = o.rng;
    const bot = create(skill);
    const inputs = [];
    const maxTicks = o.maxTicks || 10 * 3600 * 60;   // 안전 상한(틱 단위)
    while (eng.ticks < maxTicks && eng.state !== 'over') {
      const acts = bot.act(eng);
      for (let i = 0; i < acts.length; i++) inputs.push({ t: eng.ticks + 1, a: acts[i].a, k: acts[i].k });
      eng.setBuffer(acts);
      eng.tick();
    }
    const r = eng.result();
    return {
      v: RP.VERSION,
      mode: r.mode, level: r.level, g20: r.g20, seed: r.seed,
      ticks: r.ticks, score: r.score, lines: r.lines, pieces: r.pieces, hash: r.hash,
      overReason: r.overReason,
      inputs: inputs,
      engine: eng,
    };
  }

  return { create: create, run: run, evaluations: evaluations, makeRand: makeRand, PRESETS: PRESETS, weights: W };
});
