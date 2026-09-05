/** 서버 설정. 환경변수로 덮어쓰기 가능. */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.NT_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 시크릿: 없으면 1회 생성해 data/secret 에 보관 (서버 재시작에도 토큰·IP해시 안정 유지) */
function loadSecret() {
  if (process.env.NT_SECRET) return process.env.NT_SECRET;
  const p = path.join(DATA_DIR, 'secret');
  try {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (e) { /* 없다 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, s, { mode: 0o600 });
  return s;
}

const LIMITS = {
  bodyBytes: 512 * 1024,        // 제출 본문 상한
  maxInputs: 40000,
  maxTicks: 4 * 3600 * 60,    // 4시간(틱 단위! 864,000 틱)
  /** 속도 관련 하한은 **플래그** 용도(기각 아님). 렌더가 밀리면 게임 시간이 압축되어
   *  정직한 플레이어도 초인적으로 보일 수 있다. 기각은 형태/시드/불일치/월클럭만. */
  minTicksAbs: 45,              // 0.75초 미만 실행은 제출 불가
  flagTicksPerPiece: 10,        // 조각당 10틱 미만 = 6 PPS 이상 → 의심
  flagTicksPerLine: 24,         // 줄당 24틱 미만 = 초당 2.5줄 → 의심
  // 레이트리밋 (fp/ip 기준, 분 단위 윈도우)
  tokenPerHour: 40,
  submitPerHour: 30,
  submitPerMin: 6,
  boardCacheMs: 5000,
  /* 검증 큐 — 재시뮬은 CPU를 먹고 요청 경로(단일 스레드)를 막으므로 워커로 보낸다. */
  workers: parseInt(process.env.NT_WORKERS || '0', 10) || Math.max(1, Math.min(4, require('os').cpus().length - 1)),
  queueCap: parseInt(process.env.NT_QUEUE_CAP || '400', 10),   // 대기열 상한(초과 시 503/429)
  inFlightPerIp: parseInt(process.env.NT_INFLIGHT_IP || '2', 10),   // 한 네트워크의 동시 대기 제출
  inFlightPerFp: 3,
  etaPerTick: 1.15e-6,            // 틱당 예상 검증 시간(초) — 대기 위치 안내용
  ipRetentionDays: 30,
  rejectsBeforeBan: 6,          // 1시간 내 기각 6회 → 차단 (위조 반복 시도)
  /**
   * 월클럭 검사 유예(밀리초). 실제 시간보다 게임 시간이 길 수는 없는데,
   * 테스트는 판을 순식간에 돌려야 하므로 NT_TEST_MODE 일 때만 늘린다.
   */
  wallclockGraceMs: 3000,
};

const TEST_MODE = process.env.NT_TEST_MODE === '1';
if (TEST_MODE) {
  // 테스트는 같은 IP에서 수십 판을 순식간에 돌린다 → 속도 제한만 풀고 로직은 그대로 태운다.
  LIMITS.wallclockGraceMs = parseInt(process.env.NT_WALLCLOCK_GRACE_MS || '86400000', 10);
  LIMITS.submitPerMin = 200;
  LIMITS.submitPerHour = 2000;
  LIMITS.tokenPerHour = 2000;
  LIMITS.rejectsBeforeBan = 4;
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'tetris.db'),
  SECRET: loadSecret(),
  TEST_MODE,
  PORT: parseInt(process.env.PORT || process.env.NT_PORT || '8787', 10),
  HOST: process.env.NT_HOST || '0.0.0.0',
  /** 리버스 프록시 뒤 X-Forwarded-For的信任 여부 (숫자 = trusted proxy hop 수) */
  TRUST_PROXY_HOPS: parseInt(process.env.NT_TRUST_HOPS || '1', 10),
  BASE_URL: process.env.NT_BASE_URL || null,   // 공유 링크 절대 URL 생성용
  LIMITS,
  /** 재시뮬 동시성 (CPU 보호) */
  SIM_SLOTS: parseInt(process.env.NT_SIM_SLOTS || '3', 10),
  /** 상위 N위 이내 자동 flag → 사람 검수 대상 */
  REVIEW_TOP_N: 20,
};
