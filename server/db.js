/**
 * SQLite 저장소 (node:sqlite 내장 — 외부 의존성 0)
 *
 * 설계 규칙
 *  · 검증/순위 데이터는 **append-only**. 순위·시점 이력은 지우면 다시 만들 수 없어 삭제하지 않는다.
 *    숨김은 status 필터로만 한다 (withdrawn = 본인 요청 / hidden = 운영 판단 / rejected = 검증 실패).
 *  · 원문 IP는 저장하지 않는다. HMAC 해시(일 단위 도메인)와 공개용 마스킹 값만 보관, 기간 지난 건 파기.
 *  · 닉네임(display_name)은 기록의 메타데이터일 뿐 조회 키로 쓰지 않는다 → 이름으로 뒤지는 공격면이 없다.
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const CFG = require('./config');
const NAMES = require('../identity.js');

const db = new DatabaseSync(CFG.DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 4000;

CREATE TABLE IF NOT EXISTS tokens (
  seed        TEXT PRIMARY KEY,
  board       TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  used_at     INTEGER,
  ip_hash     TEXT,
  fp          TEXT
);

CREATE TABLE IF NOT EXISTS owners (
  fp           TEXT PRIMARY KEY,      -- 공개키 지문(+체크섬). 소유자 인덱스가 아니라 표시용 ID
  codename     TEXT NOT NULL,
  display_name TEXT,                  -- 선택 입력. 보드 응답에는 절대 넣지 않는다
  lang         TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  seen_count   INTEGER NOT NULL DEFAULT 1,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY,
  share        TEXT NOT NULL UNIQUE,  -- URL 키(마지막 1자 = 오타 탐지 체크섬)
  digest       TEXT NOT NULL UNIQUE,  -- SHA256(정규화 리플레이) → 선등록 우선, 사본 차단
  replay       TEXT NOT NULL,         -- packed 원문. 검증 후에도 수정하지 않는다
  board        TEXT NOT NULL,         -- mode:level:g20
  mode         TEXT NOT NULL,
  level        INTEGER NOT NULL,
  g20          INTEGER NOT NULL,
  seed         TEXT NOT NULL UNIQUE,  -- 서버 발급 1회용 → 재사용 제출 자체가 불가능
  score        INTEGER NOT NULL,
  lines        INTEGER NOT NULL,
  pieces       INTEGER NOT NULL,
  ticks        INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  over_reason  TEXT,
  tetrises     INTEGER, tspins INTEGER, pcs INTEGER, max_combo INTEGER,
  pps REAL, apm REAL, inp_rate REAL, input_count INTEGER,
  ghost        TEXT,                  -- 서버 시뮬 파생 고스트 타임라인 [{t,s,l}]
  status       TEXT NOT NULL,         -- verified | flagged | rejected | withdrawn | hidden
  flags        TEXT,                  -- JSON 사유 코드 배열
  reject       TEXT,
  sim_ms INTEGER, verify_ms INTEGER,
  fp TEXT, ip_hash TEXT, ip_hint TEXT,
  reveal       INTEGER NOT NULL DEFAULT 1,
  challenge_of TEXT,                  -- 격파 대상 share 키
  rank_at_submit INTEGER,
  client_ver TEXT, lang TEXT, issued_at INTEGER, submitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_board_verified ON runs(board, status, score DESC, ticks ASC);
CREATE INDEX IF NOT EXISTS ix_board_time     ON runs(board, status, ticks ASC);
CREATE INDEX IF NOT EXISTS ix_fp             ON runs(fp, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_iph            ON runs(ip_hash, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_created        ON runs(submitted_at DESC);

CREATE TABLE IF NOT EXISTS rank_events (      -- 순위 변동 이력 (삭제 금지)
  id INTEGER PRIMARY KEY,
  board TEXT NOT NULL, run_id INTEGER NOT NULL, rank INTEGER NOT NULL,
  metric INTEGER NOT NULL, kind TEXT NOT NULL,   -- submit | top1
  beat_run_id INTEGER, beat_score INTEGER, gap INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_re_board ON rank_events(board, at DESC);
CREATE INDEX IF NOT EXISTS ix_re_run   ON rank_events(run_id);

CREATE TABLE IF NOT EXISTS rank_hold (        -- 1위 유지 시간 (진행중 → 마감). 보드당 여러 행 = 이력 전체 보존
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL, run_id INTEGER NOT NULL, since INTEGER NOT NULL, until_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ix_hold_run ON rank_hold(run_id);
CREATE INDEX IF NOT EXISTS ix_hold_board ON rank_hold(board, until_ms);

CREATE TABLE IF NOT EXISTS board_snap (       -- 1시간 스냅샷 → 기간 필터/명예의 전당
  taken_at INTEGER NOT NULL, board TEXT NOT NULL, rank INTEGER NOT NULL,
  run_id INTEGER NOT NULL, metric INTEGER NOT NULL,
  PRIMARY KEY (board, rank, taken_at)
);
CREATE TABLE IF NOT EXISTS period_best (      -- 요/주/월 챔피언 (밀려난 순위도 남는다)
  period TEXT NOT NULL, board TEXT NOT NULL, rank INTEGER NOT NULL,
  run_id INTEGER NOT NULL, metric INTEGER NOT NULL, taken_at INTEGER NOT NULL,
  PRIMARY KEY (period, board, rank)
);
CREATE TABLE IF NOT EXISTS periods_seen (
  period TEXT NOT NULL, board TEXT NOT NULL, PRIMARY KEY(period, board)
);

CREATE TABLE IF NOT EXISTS playbacks (
  run_id INTEGER NOT NULL, at INTEGER NOT NULL, viewer TEXT, src TEXT, via TEXT
);
CREATE INDEX IF NOT EXISTS ix_pb ON playbacks(run_id, at DESC);

CREATE TABLE IF NOT EXISTS rate (
  k TEXT PRIMARY KEY, n INTEGER NOT NULL, window_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  k TEXT PRIMARY KEY, reason TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

/* 구 버전 마이그레이션: rank_hold 가 보드당 1행이던 스키마는 밀려난 1위 이력을 덮어써서 잃었다 */
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(rank_hold)').all().map(c => c.name);
  if (cols.length && cols.indexOf('id') < 0) {
    console.log('[migrate] rank_hold 를 이력 테이블로 변환');
    db.exec(`CREATE TABLE rank_hold_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board TEXT NOT NULL, run_id INTEGER NOT NULL, since INTEGER NOT NULL, until_ms INTEGER);
      INSERT INTO rank_hold_new(board, run_id, since, until_ms) SELECT board, run_id, since, until_ms FROM rank_hold;
      DROP TABLE rank_hold;
      ALTER TABLE rank_hold_new RENAME TO rank_hold;
      CREATE INDEX IF NOT EXISTS ix_hold_run ON rank_hold(run_id);
      CREATE INDEX IF NOT EXISTS ix_hold_board ON rank_hold(board, until_ms);`);
  }
})();

/* ================= 유틸 ================= */
const now = () => Date.now();
const VIS = "('verified','flagged')";

function hmac(val, window) {
  return crypto.createHmac('sha256', CFG.SECRET)
    .update(String(window || 0) + '|' + val).digest('hex').slice(0, 24);
}
/** 일 단위로 도메인을 바꿔 구우면 서버도 "어제 그 IP"를 되물어볼 수 없다 */
function ipToHash(ip) { return hmac(ip, Math.floor(now() / 864e5)); }
function boardKey(mode, level, g20) { return mode + ':' + (level | 0) + ':' + (g20 ? 1 : 0); }
function boardParts(key) {
  const p = String(key).split(':');
  return { mode: p[0], level: parseInt(p[1], 10) || 1, g20: p[2] === '1' };
}
function metricOf(mode) { return mode === 'sprint' ? 'time' : 'score'; }

function shareKey() {
  const raw = crypto.randomBytes(6).toString('hex');
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i) * (i + 3);
  return raw + (sum % 36).toString(36);
}
function validShare(key) {
  if (!/^[0-9a-f]{12}[0-9a-z]$/.test(String(key || ''))) return false;
  let sum = 0;
  const raw = key.slice(0, 12);
  for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i) * (i + 3);
  return (sum % 36).toString(36) === key.slice(12);
}

/* ================= 레이트리밋 / 차단 ================= */
function isBanned(key) { return !!db.prepare('SELECT 1 FROM bans WHERE k = ?').get(key); }
function ban(key, reason) {
  db.prepare('INSERT OR REPLACE INTO bans(k, reason, at) VALUES (?,?,?)').run(key, reason || 'auto', now());
}
function takeSlot(key, limit, windowMs) {
  const w = Math.floor(now() / windowMs);
  const st = db.prepare('SELECT n, window_at FROM rate WHERE k = ?');
  const row = st.get(key);
  if (!row) { db.prepare('INSERT INTO rate(k, n, window_at) VALUES (?,1,?)').run(key, w); return true; }
  if (row.window_at !== w) {
    db.prepare('UPDATE rate SET n = 1, window_at = ? WHERE k = ?').run(w, key);
    return true;
  }
  if (row.n >= limit) return false;
  db.prepare('UPDATE rate SET n = n + 1 WHERE k = ?').run(key);
  return true;
}
/** 세는 일만 하는 슬롯 (기각 횟수 누적 → 임계 초과 시 차단 판단 재료) */
function countUp(key, windowMs) {
  const w = Math.floor(now() / windowMs);
  const row = db.prepare('SELECT n, window_at FROM rate WHERE k = ?').get(key);
  if (!row || row.window_at !== w) {
    db.prepare('INSERT INTO rate(k, n, window_at) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n = 1, window_at = excluded.window_at').run(key, w);
    return 1;
  }
  db.prepare('UPDATE rate SET n = n + 1 WHERE k = ?').run(key);
  return row.n + 1;
}

/* ================= 토큰(시드) 발급/소진 ================= */
function issueToken(board, iph, fp) {
  let seed = '';
  do {
    seed = crypto.randomBytes(9).toString('base64url').replace(/[^0-9a-zA-Z]/g, '');
  } while (seed.length < 8 || db.prepare('SELECT 1 FROM tokens WHERE seed = ?').get(seed));
  db.prepare('INSERT INTO tokens(seed, board, issued_at, ip_hash, fp) VALUES (?,?,?,?,?)')
    .run(seed, board, now(), iph || null, fp || null);
  return seed;
}
/** 1회용 시드 소진. 없거나 이미 쓰였으면 실패 → 위조/재사용 시드 제출 원천 차단 */
function consumeToken(seed, iph, fp) {
  const t = db.prepare('SELECT * FROM tokens WHERE seed = ?').get(seed);
  if (!t) return { ok: false, why: 'seed-unknown' };
  if (t.used_at) return { ok: false, why: 'seed-used', usedAt: t.used_at, board: t.board };
  if (now() - t.issued_at > 6 * 36e5) return { ok: false, why: 'seed-stale', board: t.board };
  db.prepare('UPDATE tokens SET ip_hash = COALESCE(ip_hash, ?), fp = COALESCE(fp, ?) WHERE seed = ?')
    .run(iph || null, fp || null, seed);
  const r = db.prepare('UPDATE tokens SET used_at = ? WHERE seed = ? AND used_at IS NULL').run(now(), seed);
  return { ok: r.changes === 1, why: r.changes === 1 ? null : 'seed-used', board: t.board, issuedAt: t.issued_at };
}
/** 소진하지 않고 상태만 본다 — 비싼 재시뮬 전에 싼 검사로 걸러 재시도 비용을 줄인다 */
function peekToken(seed) {
  const t = db.prepare('SELECT * FROM tokens WHERE seed = ?').get(seed);
  if (!t) return { ok: false, why: 'seed-unknown' };
  if (t.used_at) return { ok: false, why: 'seed-used', usedAt: t.used_at, board: t.board, issuedAt: t.issued_at };
  if (now() - t.issued_at > 6 * 36e5) return { ok: false, why: 'seed-stale', board: t.board };
  return { ok: true, board: t.board, issuedAt: t.issued_at };
}
/** 기각된 제출은 시드를 되돌려주지 않는다(재시도 어뷰징 방지). 대신 만료 토큰은 정리 대상. */
function sweepTokens() {
  const r = db.prepare('DELETE FROM tokens WHERE used_at IS NULL AND issued_at < ?').run(now() - 7 * 864e5);
  return r.changes;
}

/* ================= 소유자(지문) — 소유자 인덱스가 아니라 표시용 ================= */
function touchOwner(fp, displayName, lang) {
  const cn = NAMES.codename(fp, lang || 'ko');
  db.prepare(`INSERT INTO owners(fp, codename, display_name, lang, first_seen, last_seen, seen_count)
    VALUES (?,?,?,?,?,?,1)
    ON CONFLICT(fp) DO UPDATE SET
      last_seen = excluded.last_seen,
      seen_count = seen_count + 1,
      display_name = COALESCE(excluded.display_name, owners.display_name),
      lang = COALESCE(excluded.lang, owners.lang)`).run(fp, cn, displayName || null, lang || null, now(), now());
  return db.prepare('SELECT * FROM owners WHERE fp = ?').get(fp);
}
function ownerOf(fp) { return fp ? db.prepare('SELECT fp, codename, display_name, first_seen, seen_count FROM owners WHERE fp = ?').get(fp) : null; }

/* ================= 기록 등록 ================= */
const RUN_COLS = new Set(db.prepare('PRAGMA table_info(runs)').all().map(r => r.name));
function insert(row) {
  const keys = Object.keys(row);
  const bad = keys.filter(k => !RUN_COLS.has(k));
  if (bad.length) throw new Error('runs 에 없는 열: ' + bad.join(',') + ' (열 이름은 PRAGMA table_info(runs) 참고)');
  const sql = `INSERT INTO runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map(k => {
    const v = row[k];
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(' 유한하지 않은 숫자: ' + k);
    return v;
  }));
}

function rankOnBoard(board, run) {
  const time = metricOf(boardParts(board).mode) === 'time';
  const sql = time
    ? `SELECT COUNT(*) c FROM runs WHERE board = ? AND status IN ${VIS}
        AND (ticks < ? OR (ticks = ? AND id < ?))`
    : `SELECT COUNT(*) c FROM runs WHERE board = ? AND status IN ${VIS}
        AND (score > ? OR (score = ? AND id < ?))`;
  const v = time ? run.ticks : run.score;
  return db.prepare(sql).get(board, v, v, run.id).c + 1;
}
function topOfBoard(board) {
  const time = metricOf(boardParts(board).mode) === 'time';
  const sql = time
    ? `SELECT * FROM runs WHERE board = ? AND status IN ${VIS} ORDER BY ticks ASC, score DESC LIMIT 1`
    : `SELECT * FROM runs WHERE board = ? AND status IN ${VIS} ORDER BY score DESC, ticks ASC LIMIT 1`;
  return db.prepare(sql).get(board);
}

/**
 * 등록 → 순위 계산 → 이력 기록. `row` 는 DB 열 이름 그대로 (서버가 직접 만든다).
 * 어떤 경우에도 기존 데이터를 지우지 않는다.
 */
function registerRun(row, meta) {
  const full = Object.assign({}, row, {
    fp: meta.fp || row.fp || null,
    ip_hash: meta.ipHash || null,
    ip_hint: meta.ipHint || null,
    reveal: meta.reveal === false ? 0 : 1,
    challenge_of: meta.challengeOf || null,
    client_ver: meta.clientVer || null,
    lang: meta.lang || null,
    issued_at: meta.issuedAt || null,
    submitted_at: now(),
  });
  if (Array.isArray(full.flags)) full.flags = JSON.stringify(full.flags);
  const info = insert(full);
  const id = Number(info.lastInsertRowid);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  const rank = rankOnBoard(full.board, run);
  db.prepare('UPDATE runs SET rank_at_submit = ? WHERE id = ?').run(rank, id);
  const metric = metricOf(full.mode) === 'time' ? full.ticks : full.score;
  db.prepare(`INSERT INTO rank_events(board, run_id, rank, metric, kind, beat_run_id, beat_score, gap, at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(full.board, id, rank, metric, 'submit', null, null, null, now());

  if (rank === 1) {
    const open = db.prepare('SELECT * FROM rank_hold WHERE board = ? AND until_ms IS NULL').get(full.board);
    const beaten = open && open.run_id !== id ? db.prepare('SELECT * FROM runs WHERE id = ?').get(open.run_id) : null;
    if (open) db.prepare('UPDATE rank_hold SET until_ms = ? WHERE board = ? AND until_ms IS NULL').run(now(), full.board);
    db.prepare('INSERT INTO rank_hold(board, run_id, since) VALUES (?,?,?)').run(full.board, id, now());
    db.prepare(`INSERT INTO rank_events(board, run_id, rank, metric, kind, beat_run_id, beat_score, gap, at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(full.board, id, 1, metric, 'top1',
      beaten ? beaten.id : null, beaten ? beaten.score : null,
      beaten ? Math.abs(full.score - beaten.score) : null, now());
  }
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

/* ================= 조회 — 응답에 display_name을 넣지 않는다 ================= */
const BOARD_COLS = `id, share, board, mode, level, g20, score, lines, pieces, ticks, status, flags,
                    fp, reveal, rank_at_submit, tetrises, tspins, pcs, over_reason, submitted_at, challenge_of`;

function listBoard(board, opt) {
  opt = opt || {};
  const limit = Math.min(200, opt.limit || 25);
  const time = metricOf(boardParts(board).mode) === 'time';
  const where = opt.strict ? `status = 'verified'` : `status IN ${VIS}`;
  return db.prepare(`SELECT ${BOARD_COLS} FROM runs WHERE board = ? AND ${where}
    ORDER BY ${time ? 'ticks ASC, score DESC' : 'score DESC, ticks ASC'} LIMIT ? OFFSET ?`)
    .all(board, limit, opt.offset || 0);
}
function countBoard(board) {
  return db.prepare(`SELECT COUNT(*) c FROM runs WHERE board = ? AND status IN ${VIS}`).get(board).c;
}
function boards() {
  return db.prepare(`SELECT board, COUNT(*) n FROM runs WHERE status IN ${VIS} GROUP BY board ORDER BY n DESC`).all();
}
const getRunByShare = (s) => db.prepare('SELECT * FROM runs WHERE share = ?').get(s);
const getRunByDigest = (d) => db.prepare('SELECT * FROM runs WHERE digest = ?').get(d);
const getRunById = (i) => db.prepare('SELECT * FROM runs WHERE id = ?').get(i);
function runsByFp(fp, limit) {
  return db.prepare(`SELECT ${BOARD_COLS} FROM runs WHERE fp = ? ORDER BY submitted_at DESC LIMIT ?`)
    .all(fp, Math.min(100, limit || 50));
}
function totals() {
  const c = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    runs: c('SELECT COUNT(*) c FROM runs'),
    verified: c(`SELECT COUNT(*) c FROM runs WHERE status='verified'`),
    flagged: c(`SELECT COUNT(*) c FROM runs WHERE status='flagged'`),
    rejected: c(`SELECT COUNT(*) c FROM runs WHERE status='rejected'`),
    today: c('SELECT COUNT(*) c FROM runs WHERE submitted_at > ?', now() - 864e5),
    netsToday: c('SELECT COUNT(DISTINCT ip_hash) c FROM runs WHERE submitted_at > ?', now() - 864e5),
    playersToday: c('SELECT COUNT(DISTINCT fp) c FROM runs WHERE submitted_at > ?', now() - 864e5),
    plays: c('SELECT COUNT(*) c FROM playbacks'),
  };
}

/* ================= 스냅샷 / 기간 챔피언 ================= */
function isoWeek(ms) {
  const t = new Date(ms);
  const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const num = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - num + 3);           // 목요일 기준 ISO 주
  const first = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((day - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return day.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function periodKeys(ms) {
  const d = new Date(ms);
  const iso = (x) => String(x).padStart(2, '0');
  const ymd = d.getUTCFullYear() + '-' + iso(d.getUTCMonth() + 1) + '-' + iso(d.getUTCDate());
  return {
    day: 'd:' + ymd,
    week: 'w:' + isoWeek(ms),
    month: 'm:' + d.getUTCFullYear() + '-' + iso(d.getUTCMonth() + 1),
  };
}
/** 기간 목록은 "실제로 그 기간에 기록이 있던" 것만 노출 (빈 보드 방지) */
function knownPeriods() {
  return db.prepare('SELECT period FROM periods_seen ORDER BY period DESC LIMIT 400').all().map(r => r.period);
}
function snapshot(topN) {
  const at = Math.floor(now() / 36e5) * 36e5;
  const n = topN || 10;
  let rows = 0;
  for (const b of boards()) {
    const list = listBoard(b.board, { limit: n });
    list.forEach((r, i) => {
      const metric = metricOf(r.mode) === 'time' ? r.ticks : r.score;
      db.prepare('INSERT OR REPLACE INTO board_snap(taken_at, board, rank, run_id, metric) VALUES (?,?,?,?,?)')
        .run(at, b.board, i + 1, r.id, metric);
      const pk = periodKeys(r.submitted_at || now());
      const time = metricOf(r.mode) === 'time';
      for (const key of [pk.day, pk.week, pk.month]) {
        db.prepare('INSERT INTO periods_seen(period, board) VALUES (?,?) ON CONFLICT(period, board) DO NOTHING').run(key, b.board);
        const prev = db.prepare('SELECT metric, run_id, taken_at FROM period_best WHERE period = ? AND board = ? AND rank = ?')
          .get(key, b.board, i + 1);
        const better = !prev || (time ? metric < prev.metric : metric > prev.metric);
        if (!prev) {
          db.prepare('INSERT INTO period_best(period, board, rank, run_id, metric, taken_at) VALUES (?,?,?,?,?,?)')
            .run(key, b.board, i + 1, r.id, metric, r.submitted_at || now());
        } else if (better) {
          db.prepare(`UPDATE period_best SET metric = ?, run_id = ?, taken_at = MIN(taken_at, ?)
                      WHERE period = ? AND board = ? AND rank = ?`)
            .run(metric, r.id, r.submitted_at || now(), key, b.board, i + 1);
        } else {
          db.prepare('UPDATE period_best SET taken_at = MIN(taken_at, ?) WHERE period = ? AND board = ? AND rank = ?')
            .run(r.submitted_at || now(), key, b.board, i + 1);
        }
      }
      rows++;
    });
  }
  return { at, rows };
}
function periodBoard(periodKey, board, limit) {
  return db.prepare(`SELECT pb.rank, pb.metric, pb.taken_at, ${BOARD_COLS.split(',').map(c => 'r.' + c.trim()).join(',')}
                     FROM period_best pb JOIN runs r ON r.id = pb.run_id
                     WHERE pb.period = ? ${board ? 'AND pb.board = ?' : ''}
                     ORDER BY pb.rank ASC LIMIT ?`)
    .all(periodKey, ...(board ? [board] : []), Math.min(50, limit || 10));
}
function periodList(board) {
  return db.prepare(`SELECT DISTINCT period FROM period_best ${board ? 'WHERE board = ?' : ''}
                     ORDER BY period DESC LIMIT ?`).all(...(board ? [board] : []), 60).map(r => r.period);
}
/** 1위 유지 시간 — 진행중/마감 모두. 밀려난 뒤에도 이력은 남는다 */
function holdInfo(board) {
  const cur = db.prepare('SELECT rh.*, r.share, r.score, r.ticks, r.fp FROM rank_hold rh JOIN runs r ON r.id = rh.run_id WHERE rh.board = ? AND rh.until_ms IS NULL').get(board);
  return {
    current: cur || null,
    past: db.prepare(`SELECT rh.run_id, rh.since, rh.until_ms, rh.until_ms - rh.since AS held_ms, r.share, r.score, r.ticks, r.fp, r.status
                      FROM rank_hold rh JOIN runs r ON r.id = rh.run_id
                      WHERE rh.board = ? AND rh.until_ms IS NOT NULL
                      ORDER BY rh.until_ms DESC LIMIT 20`).all(board),
  };
}
/** 이 기록이 1위였던 기간 목록 (밀려난 뒤에도 사라지지 않음) */
function holdForRun(runId) {
  return db.prepare(`SELECT board, since, until_ms,
                            COALESCE(until_ms, ?) - since AS held_ms
                     FROM rank_hold WHERE run_id = ? ORDER BY since DESC`)
    .all(now(), runId);
}
function lineageOf(runId) {
  return db.prepare(`SELECT e.kind, e.rank, e.at, e.beat_run_id, e.beat_score, e.gap,
                            b.share AS beat_share, b.score AS beat_score2, b.ticks AS beat_ticks,
                            b.fp AS beat_fp, o.codename AS beat_codename
                     FROM rank_events e
                     LEFT JOIN runs b ON b.id = e.beat_run_id
                     LEFT JOIN owners o ON o.fp = b.fp
                     WHERE e.run_id = ? ORDER BY e.at ASC`).all(runId);
}
function bestRankOf(runId) {
  const r = db.prepare('SELECT MIN(rank) m FROM rank_events WHERE run_id = ?').get(runId);
  return r && r.m != null ? r.m : null;
}

/* ================= 기타 ================= */
function playback(runId, viewer, src, via) {
  db.prepare('INSERT INTO playbacks(run_id, at, viewer, src, via) VALUES (?,?,?,?,?)')
    .run(runId, now(), viewer || null, src || null, via || null);
}
function recordNote(runId, status) {   // 숨김도 삭제 없음
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status || 'withdrawn', runId);
  db.prepare('UPDATE rank_hold SET until_ms = ? WHERE run_id = ? AND until_ms IS NULL').run(now(), runId);
}
function pruneIps(days) {              // PII만 파기, 기록은 남는다
  const r = db.prepare('UPDATE runs SET ip_hash = NULL, ip_hint = NULL WHERE submitted_at < ?')
    .run(now() - (days || CFG.LIMITS.ipRetentionDays) * 864e5);
  db.prepare('DELETE FROM rate WHERE window_at < ?').run(Math.floor(now() / 6e4) - 60 * 24 * 7);
  return r.changes;
}

module.exports = {
  db, now,
  hmac, ipToHash, boardKey, boardParts, metricOf, shareKey, validShare,
  isBanned, ban, takeSlot, countUp,
  issueToken, consumeToken, peekToken, sweepTokens,
  touchOwner, ownerOf,
  registerRun, rankOnBoard, topOfBoard,
  listBoard, countBoard, boards, getRunByShare, getRunByDigest, getRunById, runsByFp, totals,
  snapshot, periodBoard, periodList, knownPeriods, periodKeys,
  holdInfo, holdForRun, lineageOf, bestRankOf,
  playback, recordNote, pruneIps,
};
