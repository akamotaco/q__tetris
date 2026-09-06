/**
 * NEON TETRIS — 결정론적 시뮬레이션 엔진 (DOM/타이머 의존 0)
 *
 * 모든 게임 로직은 "틱(1/60초)" 단위로만 진행되고, 모든 타이머는 정수 틱이다.
 * → 같은 시드 + 같은 입력 목록이면 브라우저/서버 어디서나 결과가 비트 단위로 동일하다.
 *   이 성질이 리플레이 서버 검증(치팅 판정)의 기반이다.
 *
 * 시각 효과(파티클·화면 흔들림·사운드)는 여기에 없고 events 큐로만 전달되며,
 * 렌더러가 자체 랜덤으로 생성하므로 상태 해시에 영향을 주지 않는다.
 */
(function (root, factory) {
  const core = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.TetrisCore;
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C) {
  'use strict';

  /* ---------- 시간 상수: 전부 정수 틱 (1 tick = 1/60 s) ---------- */
  const TICK = 1 / 60;
  const HZ = 60;
  const DAS = 8;          // 133ms (구 140ms에 가장 가까운 정수)
  const ARR = 2;          // 33ms
  const SOFT = 2;         // 소프트 드롭 최소 간격
  const LOCK = 30;        // 락 딜레이 500ms
  const MAX_RESETS = 15;  // 스파이크 리셋 한도
  const CLEAR_TICKS = 16; // 줄 삭제 연출 267ms
  const MAX_LEVEL = 20;
  const PREVIEW = 5;

  /**
   * 스폰 행: 조각의 **맨 위 점유 칸**이 놓이는 "보이는 행" 번호.
   *   0  → 조각이 나온 순간 완전히 보인다 (현재 선택)
   *  -1 / -2 → Tetris Worlds 식. 조각이 숨은 행에서 태어나 첫 1~2초 윗칸이 잘려 보인다.
   * 공식은 이 행을 하나로 못 박지 않는다("나중 게임은 1행 아래, 어떤 게임은 2행 아래").
   * 즉 선택의 영역이지만, **어느 쪽을 골랐는지 여기에 상수로 남아 있다** — 바꾸면 RULES_ID 도 올린다.
   */
  const SPAWN_ROW = 0;

  /**
   * 규칙 버전. 리플레이는 "같은 입력 → 같은 결과"를 약속하는 문서 같은 것이므로,
   * 점수표·킥 테이블·T-스핀 판정 같은 규칙을 바꾸면 반드시 올린다.
   * 안 올리면 과거 리플레이가 서버에서 다른 점수로 재현되어 **검증 불가능한 유물**이 되고,
   * 그건 나중에 되돌릴 방법이 없다.
   *   r1 : SRS+월킥, 3-corner T-스핀(5th킥 full 승격), **하드 드롭으로 이동하면 스핀 해제**, 가이드라인 스코어링
   *   r2 : SRS 월킥의 세로 부호를 가이드라인(y-up) 좌표계로 바로잡음. r1 은 원문 값을 화면 좌표에
   *        그대로 적용해 킥의 위/아래가 뒤집혀 있었다 → 공식 SRS와 다른 셋업이 만들어졌다.
   *   r3 : 상단 버퍼 행(4행) 도입 + lock out 을 '조각이 전부 보이는 판 위에 잠길 때' 로 완화,
   *        O 조각 회전도 성공으로 취급(r2 까지는 실패). 보드 해시는 24행 전체 대상.
   *   r4 : **필드를 공식 서술 그대로 10×40 으로**(버퍼 4→20행) — r3 까지는 보이는 판 위 4행에
   *        인위적 천장이 있어 40행 구현과 갈리는 지점이었고, 그 차이가 이제 사라졌다. 보드 해시는 40행 대상.
   *        같은 커밋에서 I 킥 변형(guideline) 과 스폰 행(SPAWN_ROW) 을 이름으로 고정.
   */
  const RULES_ID = 'r4';

  /**
   * 공식이 **정하지 않았거나 아예 존재하지 않는** 항목을 한 곳에 모아 둔다 ("확장").
   * 값은 전부 실제 상수를 참조한다 — 즉 여기는 "무엇을 골랐는가" 에 대한 유일한 설명서다.
   *
   * README 의 "확장" 표는 `tools/extable.js` 가 여기서 생성하고, `npm test` 가 어긋남을 검사한다.
   * (코드와 문서가 따로 노는 것 — 나중에 "이게 기본값이었나?" 하고 헤매는 것 — 을 테스트가 막는다.)
   *
   * ※ 확장이라고 해서 규칙이 아닌 게 아니다. 동작을 바꾸면 리플레이 재현이 깨지므로 RULES_ID 를 올려야 한다.
   */
  const EXTENSIONS = {
    rotate180: {
      value: '사용 (' + C.KICKS_180.length + '칸 킥, 화면 좌표 자체 설계)',
      official: '공식 SRS 에 180° 회전은 없다',
      why: '현대식 컨트롤. 180° 도 회전으로 취급되어 T-스핀이 될 수 있다. 승격 기준은 90° 와 같은 "5번째 시험(인덱스 4 이후)" 을 쓰므로, 7칸짜리 180° 테이블은 5~7번째 킥이 모두 승격 대상이다.',
    },
    preview: {
      value: PREVIEW + '개',
      official: 'NEXT 를 보여준다는 수준(관례상 1개)',
      why: '현대식 게임은 5개를 보여준다. 무작위 분포는 그대로 7-bag 라 프리뷰 개수와 무관하다.',
    },
    tspinMiniTriple: {
      value: (C.MINI_BASE[3] || 0) + '×level',
      official: 'T-스핀 MINI 표에 3줄 항목이 없다',
      why: '발생하면 점수 0 보다 나 두는 편이 낫다. 실제로는 거의 나올 수 없는 자리다.',
    },
    perfectClear: {
      value: C.PC_BASE.slice(1).join('/'),
      official: '게임별 상이 (고정된 공식값 아님)',
      why: '가이드라인 문서에 단일 표가 없다. 우린 줄 수에 비례해 오르는 쪽을 택했다.',
    },
    dasArr: {
      value: 'DAS ' + Math.round(DAS * 1000 / HZ) + 'ms / ARR ' + Math.round(ARR * 1000 / HZ) + 'ms',
      official: '미규정 (플레이어 설정 항목)',
      why: '구형 기준(140/33) 에 가장 가까운 정수 틱으로 잡았다.',
    },
    softDrop: {
      value: '최소 ' + SOFT + '틱 (초당 ' + Math.round(HZ / SOFT) + '칸 상한)',
      official: '미규정',
      why: '연속 입력 속도엔 상한이 있어야 월클럭·휴먼오버 휴리스틱이 의미를 가진다.',
    },
    clearDelay: {
      value: CLEAR_TICKS + '틱 (' + Math.round(CLEAR_TICKS * 1000 / HZ) + 'ms)',
      official: '연출이라 미규정',
      why: '틱으로 세면 리플레이 재생도 같은 타이밍이 된다(규칙에는 영향 없음).',
    },
    g20: {
      value: '옵션 (중력 1틱 = 초당 ' + HZ + '칸)',
      official: '미규정 (TGM 계열 개념)',
      why: '켜면 보드 키와 리플레이에 g20 플래그가 같이 가서 다른 보드로 섞이지 않는다.',
    },
    iKickVariant: {
      value: C.I_KICK_VARIANT,
      official: 'Guideline(Tetris Worlds) 와 Arika(TGM3) 두 종이 다 "SRS" 로 불린다',
      why: '가이드라인이 요구한 쪽은 표준 표다. 갈아끼우는 곳은 core.js:KICKS_I_BY_VARIANT 하나뿐.',
    },
    field: {
      value: '10×' + C.HEIGHT + ' (보이는 ' + C.ROWS + ' + 숨은 ' + C.BUFFER + ')',
      official: '10×40 (보이는 20 + 숨은 20)',
      why: 'r4 부터 공식 서술을 문자 그대로 따른다. 보드 해시는 전체 행 대상(숨은 블록도 재현에 영향 준다).',
    },
    spawnRow: {
      value: '보이는 행 ' + SPAWN_ROW + ' 에 맨 위 점유 칸',
      official: '게임별 차이 (Tetris Worlds 는 숨은 행에 스폰; "나중 게임은 1행 아래, 어떤 게임은 2행 아래")',
      why: '조각이 나온 순간 완전히 보이는 편이 체감이 낫다. 바꾸는 곳은 engine.js:SPAWN_ROW 하나.',
    },
  };

  /* ---------- 모드 ---------- */
  const MODES = {
    marathon: { name: 'MARATHON', targetLines: 0, timeLimit: 0, metric: 'score' },
    sprint: { name: 'SPRINT 40', targetLines: 40, timeLimit: 0, metric: 'time' },
    ultra: { name: 'ULTRA 2:00', targetLines: 0, timeLimit: 120 * HZ, metric: 'score' },
  };
  const MODE_IDS = Object.keys(MODES);

  /* ---------- 결정론적 RNG (정수 전용: 환경 무관 동일 결과) ---------- */
  function seedToU32(s) {
    let h = 2166136261 >>> 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    let s = seedToU32(seed) || 1;
    return {
      u32: function () {
        // xorshift32
        s ^= (s << 13); s >>>= 0;
        s ^= (s >>> 17);
        s ^= (s << 5); s >>>= 0;
        return s >>> 0;
      },
    };
  }

  /* ---------- 중력 표 (레벨 → 열/틱), 0 = 20G(즉시 착지) ---------- */
  const GRAVITY = [null];
  for (let l = 1; l <= MAX_LEVEL; l++) {
    GRAVITY[l] = Math.max(1, Math.round(Math.pow(0.8 - (l - 1) * 0.007, l - 1) * HZ));
  }
  function gravityTicks(level, g20) {
    if (g20) return 0;
    return GRAVITY[Math.max(1, Math.min(MAX_LEVEL, level))] || 1;
  }

  /* ---------- 상태 해시 ---------- */
  function fnv(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h >>> 0).toString(36);
  }

  /* ---------- 입력 액션 ---------- */
  const ACTIONS = ['left', 'right', 'down', 'cw', 'ccw', 'flip', 'hard', 'hold'];
  const HELD = { left: 1, right: 1, down: 1 }; // 연속 입력(누르기 유지) 액션

  function create(opts) {
    opts = opts || {};
    const mode = MODES[opts.mode] ? opts.mode : 'marathon';
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, (opts.level | 0) || 1));
    const g20 = !!opts.g20;
    const seed = String(opts.seed == null ? 'default' : opts.seed);

    const E = {
      mode: mode,
      startLevel: startLevel,
      g20: g20,
      seed: seed,
      version: 1,
      rules: RULES_ID,

      state: 'playing',      // playing | clearing | over
      overReason: null,      // topout | finish | time
      board: C.createBoard(),
      queue: [],
      piece: null,
      hold: null,
      canHold: true,

      score: 0,
      lines: 0,
      level: startLevel,
      combo: -1,
      b2b: false,
      ticks: 0,

      pieces: 0, tetrises: 0, tspins: 0, pcs: 0, maxCombo: 0, clears: [0, 0, 0, 0, 0], spins: 0,

      // 내부 타이머(정수 틱)
      dropT: 0, lockT: 0, lockResets: 0, clearT: 0, pending: null,
      lowestY: 0, lastKick: 0, spinFlag: false, lastHard: false,
      held: { left: false, right: false, down: false },
      lastDir: 0, prevDir: 0,
      das: 0, arr: 0,
      buf: [],               // 다음 틱에 적용할 입력
      events: [],            // 렌더러가 소비하는 연출 이벤트
      locks: [],             // 고스트/차트용 [{t,score,lines}]
      rng: makeRng(seed),
    };

    /* ---- 큐 채우기 (7-bag) ---- */
    let bag = [];
    function refill() {
      while (E.queue.length < PREVIEW + 1) {
        if (!bag.length) {
          bag = C.TYPES.slice();
          for (let i = bag.length - 1; i > 0; i--) {
            const j = E.rng.u32() % (i + 1);
            const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
          }
        }
        E.queue.push(bag.shift());
      }
    }

    function ev(type, data) {
      const e = data || {};
      e.type = type;
      E.events.push(e);
    }

    /* ---- 스폰 ---- */
    function spawn(type) {
      if (!type) { refill(); type = E.queue.shift(); refill(); }
      const m = C.STATES[type][0];
      E.piece = {
        type: type,
        rot: 0,
        x: Math.floor((C.COLS - m[0].length) / 2),
        /* 스폰은 보이는 판 위쪽(SPAWN_ROW) 기준 — 조각의 맨 위 점유 칸이 그 행에 온다. */
        y: C.TOP + SPAWN_ROW - C.EMPTY_TOP[type],
      };
      E.dropT = 0; E.lockT = 0; E.lockResets = 0;
      E.spinFlag = false; E.lastKick = 0; E.lastHard = false;
      E.lowestY = E.piece.y;
      E.canHold = true;
      if (C.collides(E.board, m, E.piece.x, E.piece.y)) {
        ev('spawnblocked', { piece: type });
        finish('topout');
        E.piece = null;
        return false;
      }
      ev('spawn', { piece: type });
      return true;
    }

    function matrix() { return C.STATES[E.piece.type][E.piece.rot]; }
    function grounded() { return C.collides(E.board, matrix(), E.piece.x, E.piece.y + 1); }

    function resetLock() {
      if (grounded() && E.lockResets < MAX_RESETS) {
        E.lockT = 0;
        E.lockResets++;
      }
    }

    /* ---- 기본 동작 ---- */
    function move(dx) {
      if (!E.piece || E.state === 'over') return false;
      if (C.collides(E.board, matrix(), E.piece.x + dx, E.piece.y)) return false;
      E.piece.x += dx;
      E.spinFlag = false;
      resetLock();
      ev('move');
      return true;
    }

    function rotate(dir) {
      /* O 조각도 회전은 **성공**한다 (가이드라인: O 에도 4개 회전 상태가 있고, 기본 회전은 같은 자리를 가리킨다).
         r2 까지는 O 회전을 실패로 처리해서 O로 락 딜레이 리셋을 할 수 없었다.
         킥 후보는 [[0,0]] 하나뿐이므로 위치는 움직이지 않고, T-스핀 판정은 T 조각에만 적용되어 영향이 없다. */
      if (!E.piece || E.state === 'over') return false;
      const p = E.piece;
      const from = p.rot;
      const to = dir === 2 ? (p.rot + 2) % 4 : (p.rot + (dir > 0 ? 1 : 3)) % 4;
      const table = dir === 2 ? C.KICKS_180 : C.kicksFor(p.type, from, to);
      const m = C.STATES[p.type][to];
      for (let i = 0; i < table.length; i++) {
        if (!C.collides(E.board, m, p.x + table[i][0], p.y + table[i][1])) {
          p.x += table[i][0];
          p.y += table[i][1];
          p.rot = to;
          E.lastKick = i;
          E.spinFlag = true;
          resetLock();
          ev('rotate', { dir: dir });
          return true;
        }
      }
      return false;
    }

    function stepDown(countAsSoft) {
      if (!E.piece || C.collides(E.board, matrix(), E.piece.x, E.piece.y + 1)) return false;
      E.piece.y++;
      E.spinFlag = false;
      if (E.piece.y > E.lowestY) {
        E.lowestY = E.piece.y;
        E.lockResets = 0;
        E.lockT = 0;
      }
      if (countAsSoft) E.score += 1;
      return true;
    }

    function hardDrop() {
      if (!E.piece || E.state === 'over') return;
      const m = matrix();
      const startY = E.piece.y;
      let dist = 0;
      while (!C.collides(E.board, m, E.piece.x, E.piece.y + 1)) { E.piece.y++; dist++; }
      E.lastHard = true;
      if (dist) {
        /* 가이드라인: T-스핀은 "마지막 동작이 회전"일 때만 인정된다.
           아래로 미끄러져 내려갔다면 마지막 동작은 이동이므로 스핀이 아니다.
           단 이동 거리가 0(제자리에서 회전하고 그대로 잠금)이면 회전 효과가 남는다 —
           회전 인스냅트 착지의 일반 동작과 일치. */
        E.spinFlag = false;
        E.score += dist * 2;
        ev('harddrop', {
          dist: dist,
          piece: E.piece.type,
          fromY: startY,
          landY: E.piece.y,
          cells: C.cellsOf(E.piece.type, E.piece.rot),
          x: E.piece.x,
        });
      }
      lockPiece();
    }

    function hold() {
      if (!E.piece || !E.canHold || E.state === 'over') return false;
      const cur = E.piece.type;
      const stash = E.hold;
      E.hold = cur;
      E.piece = null;
      ev('hold', { piece: cur });
      spawn(stash || null);
      E.canHold = false;          // spawn()이 true로 리셋하므로 반드시 뒤에
      return true;
    }

    /* ---- 잠금 & 줄 삭제 ---- */
    function lockPiece() {
      const p = E.piece;
      if (!p || E.state === 'over') return;
      const spin = E.spinFlag ? C.tspinKind(E.board, p, E.lastKick) : 'none';

      /* 가이드라인의 끝남 조건 두 가지 중 여기는 **lock out**: 조각이 **전부** 보이는 판 위에 잠길 때만 끝난다.
         일부만 위에 걸린 채 잠기는 것은 정상 진행이다(그 블록은 버퍼에 남아 다음에 내려온다).
         r2 까지는 칸 하나라도 위에 있으면 바로 끝났고, 버퍼 행 자체가 없었다. */
      const cells = C.cellsOf(p.type, p.rot);
      const allAbove = cells.every(function (c) { return p.y + c[1] < C.TOP; });
      const topped = allAbove;

      C.merge(E.board, p);
      E.piece = null;
      E.pieces++;
      ev('lock', { piece: p.type });

      const rows = C.fullRows(E.board);
      const n = rows.length;
      const perfect = n > 0 && C.wouldBePerfect(E.board, rows);

      E.combo = n > 0 ? E.combo + 1 : -1;
      if (E.combo > E.maxCombo) E.maxCombo = E.combo;
      const res = C.scoreClear({
        lines: n, spin: spin, combo: E.combo, level: E.level,
        perfect: perfect, b2b: E.b2b, hardDrop: !!E.lastHard,
      });
      E.score += res.points;

      if (n > 0) {
        E.clears[n]++;
        if (n === 4) E.tetrises++;
        if (spin !== 'none') E.tspins++;
        if (perfect) E.pcs++;
        E.b2b = res.difficult;
      } else if (spin !== 'none') {
        E.tspins++;
      }
      if (spin !== 'none') E.spins++;

      const info = {
        lines: n, spin: spin, label: res.label, points: res.points,
        combo: E.combo, perfect: perfect, b2b: E.b2b,
      };
      ev('scored', info);
      if (res.label) {
        ev('popup', {
          text: res.label, sub: '+' + res.points,
          color: n >= 4 || perfect ? '#ffd83d' : spin !== 'none' ? '#c05bff' : '#35e5f5',
        });
      }
      if (E.combo > 0) ev('popup', { text: 'COMBO x' + E.combo, sub: '', color: '#3ee08f', small: true });

      E.locks.push({ t: E.ticks, score: E.score, lines: E.lines + n });

      if (n > 0) {
        E.state = 'clearing';
        E.pending = { rows: rows, lines: n };
        E.clearT = CLEAR_TICKS;
        ev('clearing', { rows: rows.slice(), lines: n, perfect: perfect });
      }

      if (topped) { finish('topout'); return; }
      if (n === 0) afterLock();
    }

    function afterLock() {
      if (E.state === 'over') return;
      E.state = 'playing';
      spawn(null);
    }

    function finalizeClear() {
      const pend = E.pending;
      C.removeRows(E.board, pend.rows);
      E.lines += pend.lines;
      const lv = Math.min(MAX_LEVEL, E.startLevel + Math.floor(E.lines / 10));
      if (lv > E.level) {
        E.level = lv;
        ev('level', { level: lv });
        ev('popup', { text: 'LEVEL ' + lv, sub: '', color: '#35e5f5', small: true });
      }
      ev('cleared', { rows: pend.rows.slice(), lines: pend.lines });
      E.pending = null;
      const M = MODES[E.mode];
      if (M.targetLines && E.lines >= M.targetLines) { finish('finish'); return; }
      afterLock();
    }

    function finish(reason) {
      if (E.state === 'over') return;
      E.state = 'over';
      E.overReason = reason;
      E.piece = null;
      E.pending = null;
      ev('gameover', { reason: reason });
    }

    /* ---- 입력 버퍼 ---- */
    function press(action) {
      if (ACTIONS.indexOf(action) < 0) return false;
      E.buf.push({ k: 1, a: action });
      return true;
    }
    function release(action) {
      if (!HELD[action]) return false;
      E.buf.push({ k: 0, a: action });
      return true;
    }

    function applyBuffer() {
      for (let i = 0; i < E.buf.length; i++) {
        const b = E.buf[i];
        if (E.state === 'over') break;
        if (!b.k) {                       // 놓기
          if (HELD[b.a]) E.held[b.a] = false;
          continue;
        }
        if (!HELD[b.a]) {                 // 단발 액션
          if (E.state === 'clearing') continue;
          if (b.a === 'cw') rotate(1);
          else if (b.a === 'ccw') rotate(-1);
          else if (b.a === 'flip') rotate(2);
          else if (b.a === 'hard') hardDrop();
          else if (b.a === 'hold') hold();
          continue;
        }
        // 누르기 유지 액션
        if (b.a === 'down') {
          E.held.down = true;
          if (E.dropT < SOFT) E.dropT = SOFT;
        } else {
          const d = b.a === 'left' ? -1 : 1;
          const was = E.held[b.a];
          E.held[b.a] = true;
          E.lastDir = d;
          E.das = 0; E.arr = 0;
          if (!was && E.state === 'playing') move(d);
        }
      }
      E.buf.length = 0;
    }

    /* ---- 1 틱 진행 ---- */
    function tick() {
      applyBuffer();
      E.ticks++;

      if (E.state === 'clearing') {
        E.clearT--;
        if (E.clearT <= 0) finalizeClear();
        return E.state !== 'over';
      }
      if (E.state !== 'playing' || !E.piece) return false;

      const M = MODES[E.mode];
      if (M.timeLimit && E.ticks >= M.timeLimit) { finish('time'); return false; }

      // 좌우 DAS / ARR (두 키를 동시에 누르면 마지막으로 누른 방향 우선)
      let dir = 0;
      if (E.held.left && E.held.right) dir = E.lastDir;
      else if (E.held.left) dir = -1;
      else if (E.held.right) dir = 1;
      if (dir !== E.prevDir) { E.das = 0; E.arr = 0; E.prevDir = dir; }
      if (dir !== 0) {
        E.das++;
        if (E.das > DAS) {
          E.arr++;
          let guard = 0;
          while (E.arr >= ARR && guard++ < 12) {
            E.arr -= ARR;
            if (!move(dir)) break;
          }
        }
      }

      // 중력
      const gt = gravityTicks(E.level, E.g20);
      if (gt === 0) {
        // 20G: 즉시 바닥까지
        while (stepDown(false)) { /* 착지 */ }
      } else {
        const interval = E.held.down ? Math.min(gt, SOFT) : gt;
        E.dropT++;
        let guard = 0;
        while (E.dropT >= interval && guard++ < 40) {
          E.dropT -= interval;
          if (!stepDown(E.held.down)) { E.dropT = 0; break; }
        }
      }

      // 락 딜레이
      if (grounded()) {
        E.lockT++;
        if (E.lockT >= LOCK) lockPiece();
      } else {
        E.lockT = 0;
      }
      return E.state !== 'over';
    }

    /* ---- 상태 조회 ---- */
    function boardHash() {
      let s = '';
      for (let y = 0; y < C.HEIGHT; y++) {
        for (let x = 0; x < C.COLS; x++) s += E.board[y][x] ? E.board[y][x] : '.';
      }
      return fnv(s);
    }

    function ghostY() {
      if (!E.piece) return 0;
      const m = matrix();
      let y = E.piece.y;
      while (!C.collides(E.board, m, E.piece.x, y + 1)) y++;
      return y;
    }

    function snapshot() {
      return {
        state: E.state, overReason: E.overReason,
        score: E.score, lines: E.lines, level: E.level, combo: E.combo, b2b: E.b2b,
        pieces: E.pieces, hold: E.hold, canHold: E.canHold,
        queue: E.queue.slice(0, PREVIEW),
        piece: E.piece ? { type: E.piece.type, rot: E.piece.rot, x: E.piece.x, y: E.piece.y } : null,
        ticks: E.ticks,
        clearing: E.state === 'clearing', clearT: E.clearT,
        pending: E.pending ? { rows: E.pending.rows.slice(), lines: E.pending.lines } : null,
        stats: {
          pieces: E.pieces, tetrises: E.tetrises, tspins: E.tspins, pc: E.pcs,
          maxCombo: E.maxCombo, clears: E.clears.slice(), spins: E.spins,
          time: E.ticks * TICK,
        },
      };
    }

    /** 서버 검증·보드에 쓰이는 최종 결과 (재현 판정 대상) */
    function result() {
      return {
        mode: E.mode, level: E.startLevel, g20: E.g20, seed: E.seed, rules: E.rules,
        score: E.score, lines: E.lines, pieces: E.pieces, ticks: E.ticks,
        hash: boardHash(),
        state: E.state, overReason: E.overReason,
        tetrises: E.tetrises, tspins: E.tspins, pcs: E.pcs, maxCombo: E.maxCombo,
      };
    }

    /** 현재 보유 중인 큐까지 전부 시드로부터 파생 → 시드 위조 방지용 검증값 */
    function sequenceHash(n) {
      refill();
      const look = E.queue.slice(0, n || PREVIEW);
      return fnv(look.join(''));
    }

    /* ---- 초기화: 첫 조각 스폰 ---- */
    refill();
    spawn(null);
    E.events.length = 0;   // 시작 스폰 연출 이벤트는 버림

    E.refill = refill;
    E.tick = tick;
    E.press = press;
    E.release = release;
    E.spawn = spawn;          // 디버그/테스트용 강제 스폰
    E.move = move;
    E.rotate = rotate;
    E.hardDrop = hardDrop;
    E.holdPiece = hold;          // E.hold(홀드 슬롯 값)와 이름 충돌 방지
    E.lockPiece = lockPiece;
    E.ghostY = ghostY;
    E.boardHash = boardHash;
    E.snapshot = snapshot;
    E.result = result;
    E.sequenceHash = sequenceHash;
    E.drainEvents = function () { const e = E.events; E.events = []; return e; };
    E.setBuffer = function (arr) { E.buf = arr.slice(); };
    return E;
  }

  /* ---------- 무두문 리플레이 → 엔진 실행 (서버 검증의 핵심) ---------- */
  /**
   * @param {object} rep replay.js가 디코딩한 리플레이
   * @param {object} opt {maxTicks}
   * @returns {{engine, trace, inputsApplied, trailing, timedOut, ticksReached, simTicks}}
   *
   * trace 는 검증 휴리스틱과 고스트 재생이 쓰는 부수 자료다:
   *   spawns/locks(틱 목록), hard(하드드롭 횟수), clears(삭제 횟수), maxStack(동일 틱 최다 입력)
   */
  function simulate(rep, opt) {
    opt = opt || {};
    const maxTicks = opt.maxTicks || 8 * 3600 * 60;   // 8시간(틱 단위) 상한
    const t0 = Date.now();
    const eng = create({ seed: rep.seed, mode: rep.mode, level: rep.level, g20: rep.g20 });
    const inputs = rep.inputs;
    const trace = { spawns: [], locks: [], hard: 0, clears: 0, rotations: 0, maxStack: 0, popups: [] };
    let idx = 0;
    while (eng.ticks < maxTicks) {
      const buf = [];
      while (idx < inputs.length && inputs[idx].t <= eng.ticks + 1) buf.push(inputs[idx++]);
      if (buf.length > trace.maxStack) trace.maxStack = buf.length;
      eng.setBuffer(buf.map(function (b) { return { k: b.k, a: b.a }; }));
      const alive = eng.tick();
      const evs = eng.drainEvents();
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        if (e.type === 'spawn') trace.spawns.push(eng.ticks);
        else if (e.type === 'lock') trace.locks.push(eng.ticks);
        else if (e.type === 'harddrop') trace.hard++;
        else if (e.type === 'rotate') trace.rotations++;
        else if (e.type === 'scored' && e.lines) trace.clears++;
        else if (e.type === 'popup' && e.text) trace.popups.push([eng.ticks, e.text]);
      }
      if (!alive || eng.state === 'over') break;
    }
    return {
      engine: eng,
      trace: trace,
      inputsApplied: idx,
      trailing: inputs.length - idx,          // 실행 종료 후 처리 못 한 입력
      timedOut: eng.state !== 'over',
      ticksReached: eng.ticks,
      simMs: Date.now() - t0,
    };
  }

  return {
    RULES_ID: RULES_ID,
    EXTENSIONS: EXTENSIONS,
    SPAWN_ROW: SPAWN_ROW,
    TICK: TICK, HZ: HZ,
    DAS: DAS, ARR: ARR, SOFT: SOFT, LOCK: LOCK, CLEAR_TICKS: CLEAR_TICKS,
    MAX_RESETS: MAX_RESETS, MAX_LEVEL: MAX_LEVEL, PREVIEW: PREVIEW,
    MODES: MODES, MODE_IDS: MODE_IDS,
    ACTIONS: ACTIONS, HELD: HELD,
    GRAVITY: GRAVITY,
    gravityTicks: gravityTicks,
    makeRng: makeRng,
    fnv: fnv,
    create: create,
    simulate: simulate,
  };
});
