/**
 * NEON TETRIS — core logic (pure, 테스트 가능한 부분)
 * SRS 회전 / 월킥 / 7-bag / 스코어링
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const COLS = 10;
  const ROWS = 20;

  const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

  const COLORS = {
    I: '#35e5f5',
    J: '#4f8dff',
    L: '#ff9f43',
    O: '#ffd83d',
    S: '#3ee08f',
    T: '#c05bff',
    Z: '#ff5c7a',
  };

  /* ---- 기본 형태 (SRS 스폰 상태) ---- */
  const BASE = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    O: [[1, 1], [1, 1]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  };

  function clone(m) { return m.map(function (r) { return r.slice(); }); }

  function rotateCW(m) {
    const n = m.length;
    const r = [];
    for (let i = 0; i < n; i++) r.push(new Array(n).fill(0));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) r[y][x] = m[n - 1 - x][y];
    return r;
  }

  /* 회전 상태 4개 미리 계산 */
  const STATES = {};
  TYPES.forEach(function (t) {
    const s = [clone(BASE[t])];
    for (let i = 0; i < 3; i++) s.push(rotateCW(s[i]));
    STATES[t] = s;
  });

  /* 매트릭스 위 첫 점유 행 / 마지막 점유 행 */
  const EMPTY_TOP = {};
  TYPES.forEach(function (t) {
    const m = BASE[t];
    let top = 0;
    while (top < m.length && m[top].every(function (v) { return v === 0; })) top++;
    EMPTY_TOP[t] = top;
  });

  /* ---- SRS 월킥 테이블 ----
     아래 값은 가이드라인(Tetris Wiki "Super Rotation System") 원문을 **그대로** 옮겨 적는다.
     단 원문 좌표계는 **y-up(위가 +)** 이다:
       "a convention of positive x rightwards, positive y upwards is used,
        e.g. (-1,+2) would indicate a kick of 1 cell left and 2 cells up"
     우리 보드는 y-down(아래가 +)이므로, 밖으로 내보내는 kicksFor() 가 세로 성분을 뒤집는다.
     이 변환을 빼먹으면 킥의 위/아래가 뒤바뀐 채로 적용되어 **공식 SRS와 다른 셋업**이 생긴다
     (0→R 4번째 시험은 본래 "2칸 아래"인데 "2칸 위"로 시도하게 된다). r1 까지 이 실수가 있었고 r2 에서 바로잡았다. */
  const KICKS_Y_UP = {
    JLSTZ: {
      '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
      '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
      '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
      '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
      '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
      '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
      '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
      '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    },
    I: {
      '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
      '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
      '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
      '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
      '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
      '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
      '3>0': [[0, 0], [1, 0], [-1, 0], [1, -2], [-1, 1]],
      '0>3': [[0, 0], [-1, 0], [1, 0], [-1, 2], [1, -1]],
    },
  };
  /* 180° 회전은 공식 SRS에 없다(현대 컨트롤 확장). 따라서 원문 테이블도 없고 값은 자체 설계이며,
     처음부터 **화면 좌표(y-down)** 로 작성했다 — 위에서 뒤집는 것들과 섞지 말 것. */
  const KICKS_180 = [[0, 0], [1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [0, -1]];

  /** 화면 좌표 기준 킥 후보 목록 (가이드라인 원문 값의 세로 성분을 변환해 반환) */
  function kicksFor(type, from, to) {
    if (type === 'O') return [[0, 0]];
    const table = type === 'I' ? KICKS_Y_UP.I : KICKS_Y_UP.JLSTZ;
    const key = from + '>' + to;
    const raw = table[key];
    if (!raw) return [[0, 0]];
    return raw.map(function (o) { return [o[0], -o[1]]; });
  }
  /** 원문 그대로의 값(진단/테스트용) */
  function kicksForGuideline(type, from, to) {
    if (type === 'O') return [[0, 0]];
    const table = type === 'I' ? KICKS_Y_UP.I : KICKS_Y_UP.JLSTZ;
    return table[from + '>' + to] || [[0, 0]];
  }

  /* ---- 보드 ---- */
  function createBoard() {
    const b = [];
    for (let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(null));
    return b;
  }

  /** 칸이 채워져 있는지 (범위 밖 좌/우/하단 = 벽, 상단 열림) */
  function isSolid(board, x, y) {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y < 0) return false;
    return !!board[y][x];
  }

  /** 매트릭스 점유 칸 좌표 리스트 */
  function cellsOf(type, rot) {
    const m = STATES[type][((rot % 4) + 4) % 4];
    const out = [];
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m[y].length; x++) if (m[y][x]) out.push([x, y]);
    }
    return out;
  }

  function collides(board, matrix, ox, oy) {
    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix[y].length; x++) {
        if (!matrix[y][x]) continue;
        if (isSolid(board, ox + x, oy + y)) return true;
      }
    }
    return false;
  }

  function merge(board, piece) {
    const m = STATES[piece.type][piece.rot];
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m[y].length; x++) {
        if (!m[y][x]) continue;
        const by = piece.y + y;
        const bx = piece.x + x;
        if (by >= 0 && by < ROWS && bx >= 0 && bx < COLS) board[by][bx] = piece.type;
      }
    }
  }

  function fullRows(board) {
    const rows = [];
    for (let y = 0; y < ROWS; y++) {
      if (board[y].every(function (c) { return !!c; })) rows.push(y);
    }
    return rows;
  }

  function removeRows(board, rows) {
    const set = {};
    rows.forEach(function (r) { set[r] = true; });
    const kept = [];
    for (let y = 0; y < ROWS; y++) if (!set[y]) kept.push(board[y]);
    while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(null));
    for (let y = 0; y < ROWS; y++) board[y] = kept[y];
    return board;
  }

  function isEmptyBoard(board) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) if (board[y][x]) return false;
    }
    return true;
  }

  /** 행을 제거했을 때 보드가 비게 되는지 (퍼펙트 클리어 예측) */
  function wouldBePerfect(board, rows) {
    const set = {};
    rows.forEach(function (r) { set[r] = true; });
    for (let y = 0; y < ROWS; y++) {
      if (set[y]) continue;
      for (let x = 0; x < COLS; x++) if (board[y][x]) return false;
    }
    return true;
  }

  /* ---- T-스핀 판정 ---- */
  function tspinKind(board, piece, kickIndex) {
    if (piece.type !== 'T') return 'none';
    const cx = piece.x + 1;
    const cy = piece.y + 1;
    const corners = [
      isSolid(board, cx - 1, cy - 1), // 0 TL
      isSolid(board, cx + 1, cy - 1), // 1 TR
      isSolid(board, cx - 1, cy + 1), // 2 BL
      isSolid(board, cx + 1, cy + 1), // 3 BR
    ];
    const front = piece.rot === 0 ? [0, 1] : piece.rot === 1 ? [1, 3] : piece.rot === 2 ? [2, 3] : [0, 2];
    const count = corners.filter(Boolean).length;
    if (count < 3) return 'none';
    if (corners[front[0]] && corners[front[1]]) return 'full';
    if (kickIndex >= 4) return 'full';
    return 'mini';
  }

  /* ---- 스코어링 ---- */
  const CLEAR_BASE = [0, 100, 300, 500, 800];
  const TSPIN_BASE = [400, 800, 1200, 1600];
  const MINI_BASE = [100, 200, 400, 600];
  const PC_BASE = [0, 800, 1200, 1800, 2000];
  const CLEAR_NAME = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];

  /**
   * @returns {{points:number,label:string,difficult:boolean,combo:number}}
   */
  function scoreClear(o) {
    const lines = o.lines | 0;
    const spin = o.spin || 'none';
    const level = o.level || 1;
    const combo = Math.max(0, o.combo | 0);
    let base = 0;
    let label = '';
    let difficult = false;

    if (spin === 'full') {
      base = TSPIN_BASE[lines] || 0;
      label = lines ? 'T-SPIN ' + (CLEAR_NAME[lines] || '') : 'T-SPIN';
      difficult = lines > 0;
    } else if (spin === 'mini') {
      base = MINI_BASE[lines] || 0;
      label = lines ? 'T-SPIN MINI ' + (CLEAR_NAME[lines] || '') : 'T-SPIN MINI';
      difficult = lines > 0;
    } else {
      base = CLEAR_BASE[lines] || 0;
      label = CLEAR_NAME[lines] || '';
      difficult = lines === 4;
    }

    let pts = base * level;
    if (difficult && o.b2b) pts = Math.round(pts * 1.5);
    if (combo > 0) pts += 50 * combo * level;

    if (o.perfect && lines > 0) {
      pts += (o.hardDrop ? 3500 : PC_BASE[lines]) * level;
      label = 'PERFECT CLEAR';
    }
    return { points: pts, label: label.trim(), difficult: difficult, combo: combo };
  }

  /* ---- 중력 (레벨별 낙하 간격, 초) ---- */
  function gravityFor(level) {
    const l = Math.max(1, level);
    return Math.pow(0.8 - (l - 1) * 0.007, l - 1);
  }

  /* ---- 7-bag 랜덤 ---- */
  function createRandomizer(rng) {
    const rand = rng || Math.random;
    let bag = [];
    return {
      next: function () {
        if (!bag.length) {
          bag = TYPES.slice();
          for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
          }
        }
        return bag.shift();
      },
    };
  }

  /* ---- 미리보기 bounding 박스 (프리뷰 정렬용) ---- */
  function bbox(type, rot) {
    const cells = cellsOf(type, rot);
    let minX = 99, maxX = -1, minY = 99, maxY = -1;
    cells.forEach(function (c) {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    });
    return { minX: minX, minY: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  return {
    COLS: COLS,
    ROWS: ROWS,
    TYPES: TYPES,
    COLORS: COLORS,
    BASE: BASE,
    STATES: STATES,
    EMPTY_TOP: EMPTY_TOP,
    KICKS_180: KICKS_180,
    CLEAR_NAME: CLEAR_NAME,
    kicksFor: kicksFor,
    kicksForGuideline: kicksForGuideline,
    createBoard: createBoard,
    isSolid: isSolid,
    cellsOf: cellsOf,
    collides: collides,
    merge: merge,
    fullRows: fullRows,
    removeRows: removeRows,
    isEmptyBoard: isEmptyBoard,
    wouldBePerfect: wouldBePerfect,
    tspinKind: tspinKind,
    scoreClear: scoreClear,
    gravityFor: gravityFor,
    createRandomizer: createRandomizer,
    bbox: bbox,
    rotateCW: rotateCW,
  };
});
