/**
 * 부하 실측 — "검증이 밀리는가", 그리고 밀리는 동안 사이트가 서는지.
 *   node tools/loadtest.js [건수]        (기본 60)
 *   NT_WORKERS=4 node tools/loadtest.js 200
 *
 * 측정 항목
 *   1) 재시뮬 실제 비용 (틱당 ms) 과 프리셋별 판 길이 → 최악 비용 추정
 *   2) N건 동시 제출의 접수 시간(=사용자가 "대기 중" 을 보는 시점) 과 전체 발행 완료 시간
 *   3) 검증이 바쁜 동안 서버(/api/health) 응답 지연  ← 이벤트 루프가 막혔는지 드러나는 자리
 *      (판 생성 CPU 는 미리 끝내 두고, 재는 동안 부모 프로세스는 아무것도 하지 않는다)
 */
'use strict';
process.env.NT_TEST_MODE = '1';
if (!process.env.NT_WORKERS) process.env.NT_WORKERS = '2';
process.env.NT_DATA = require('path').join(require('os').tmpdir(), 'nt-load-' + Math.random().toString(36).slice(2, 7));

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const RP = require('../replay.js');
const EN = require('../engine.js');
const ID = require('../identity.js');
const AI = require('./ai.js');
const V = require('../server/verify.js');

const PORT = 8973;
const BASE = 'http://127.0.0.1:' + PORT;
const N = parseInt(process.argv[2] || '60', 10);
const PAR = parseInt(process.argv[3] || '50', 10);   // 동시 연결 수

/** 간단한 풀: limit 개씩 도는 워커 없이 순서대로 당김 */
async function pooled(items, fn, limit) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 서버는 반드시 별도 프로세스 — 같은 프로세스에서 AI 를 돌리면 재려는 대상의 루프를 내가 망친다 */
function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { NT_PORT: String(PORT), NT_TEST_MODE: '1' }),
    stdio: 'ignore',
  });
  return (async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) return child; } catch (e) { }
    }
    throw new Error('서버 기동 실패');
  })();
}

function ident() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = ID.fpFromHash(crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')).fp;
  return { jwk, fp, sign: (p) => crypto.sign('sha256', Buffer.from(p), privateKey).toString('base64') };
}

async function prepare(preset, level, ip) {
  const me = ident();
  const s = await (await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ mode: 'marathon', level, fp: me.fp }),
  })).json();
  const rep = AI.run({ seed: s.seed, preset, level, rng: AI.makeRand(preset + s.seed) });
  const packed = RP.pack(rep);
  const dg = V.digestOf(RP.unpack(packed));
  return {
    ip, ticks: rep.ticks, preset,
    body: JSON.stringify({
      replay: packed, fp: me.fp, nonce: s.nonce, displayName: preset + '-' + String(s.seed).slice(0, 4),
      owner: { jwk: me.jwk, sig: me.sign(ID.authPayload('NTSUB1', [dg, s.nonce])) },
    }),
  };
}

async function send(p) {
  const r = await fetch(BASE + '/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': p.ip }, body: p.body,
  });
  return { code: r.status, json: await r.json(), ticks: p.ticks };
}

(async () => {
  const child = await startServer();

  console.log('');
  console.log('[1] 재시뮬 비용 (단일 스레드, 이 기기)');
  let worstPer1k = 0;
  for (const preset of ['casual', 'human', 'ace', 'bot']) {
    const rep = AI.run({ seed: 'cost-' + preset, preset, rng: AI.makeRand(preset) });
    const t = process.hrtime.bigint();
    EN.simulate(RP.unpack(RP.pack(rep)), {});
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const per1k = ms / (rep.ticks / 1000);
    worstPer1k = Math.max(worstPer1k, per1k);
    console.log('    ' + preset.padEnd(7) + String(rep.ticks).padStart(7) + ' 틱 / ' + (rep.ticks / 3600).toFixed(1) + '분' +
      ' | sim ' + ms.toFixed(1).padStart(6) + 'ms | 1k 틱당 ' + per1k.toFixed(2) + 'ms');
  }
  console.log('    → 상한 판(4시간 = ' + (4 * 3600 * 60).toLocaleString() + '틱) 최악 비용 ≈ ' +
    Math.round(worstPer1k * 4 * 3600 * 60 / 1000) + 'ms  (여기서 워커 수만큼 병렬)');

  console.log('');
  console.log('[2] 판 ' + N + '개 생성(리플레이 제조) — 서버 부하 측정과 분리');
  const tPrep = Date.now();
  const prepared = await Promise.all(Array.from({ length: N }, (_, i) =>
    prepare(['human', 'casual', 'ace', 'bot'][i % 4], 1 + (i % 6), '203.0.113.' + (1 + (i % 120)))));
  console.log('    ' + (Date.now() - tPrep) + 'ms');

  console.log('');
  console.log('[3] 제출 ' + N + '건 (동시 연결 ' + PAR + ') + 검증 부하 중 서버 응답 지연');
  const lags = [];
  let stop = false;
  const pinger = (async () => {
    while (!stop) {
      const t = process.hrtime.bigint();
      try { await fetch(BASE + '/api/health'); } catch (e) { }
      lags.push(Number(process.hrtime.bigint() - t) / 1e6);
      await sleep(20);
    }
  })();

  const t0 = Date.now();
  const res = await pooled(prepared, send, PAR);      // 실제 플레시 크라우드는 "동시에 200 커넥션"이 아니라 50씩 밀려온다
  const accepted = Date.now() - t0;

  let q = { waiting: 1 };
  for (let i = 0; i < 1200; i++) {
    await sleep(100);
    q = await (await fetch(BASE + '/api/queue')).json();
    if (q.waiting === 0) break;
  }
  stop = true;
  await sleep(50);
  const total = Date.now() - t0;

  const sorted = lags.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
  const st = await (await fetch(BASE + '/api/stats')).json();
  const h = await (await fetch(BASE + '/api/health')).json();
  const codes = res.reduce((a, r) => (a[r.code] = (a[r.code] || 0) + 1, a), {});

  console.log('    사용자는 ' + accepted + 'ms 안에 전부 "검증 중" 을 봅니다 → ' + (N / (accepted / 1000)).toFixed(0) + '건/초 접수');
  console.log('    전체 발행 완료 ' + total + 'ms (' + (N / (total / 1000)).toFixed(1) + '건/초)');
  const lag = h.loopLag || {};
  console.log('    서버 스스로 잰 이벤트 루프 지연: p50 ' + (lag.p50 ?? 0) + 'ms / p95 ' + (lag.p95 ?? 0) + 'ms / 최대 ' + (lag.max ?? 0) + 'ms ( 정체 샘플 ' + (lag.n || 0) + '개 )');
  console.log('    (참고) 클라에서 재 왕복: 중간 ' + pct(0.5).toFixed(1) + 'ms / p95 ' + pct(0.95).toFixed(1) + 'ms — 클라 측 경합이 섞인 숫자');
  console.log('    대기열: 최대 깊이 ' + (q.depthMax || 0) + ' · 대기 평균 ' + (q.waitAvgMs || 0) + 'ms · 최대 ' + (q.waitMsMax || 0) + 'ms');
  console.log('    큐: 워커 ' + q.workers + ' · 검증 평균 ' + q.simAvgMs + 'ms · 최대 ' + q.simMaxMs + 'ms · 완료 ' + q.done + ' · 기각 ' + q.rejected + ' · 실패 ' + q.failed);
  console.log('    상태: ' + st.runs + '건 → verified ' + st.verified + ' / flagged ' + st.flagged + ' / rejected ' + st.rejected);
  console.log('    응답 코드: ' + JSON.stringify(codes));

  const okDrain = q.waiting === 0 && (q.done + q.rejected) >= N;
  const okLag = (h.loopLag && (h.loopLag.p95 || 0) < 60);
  console.log('');
  console.log('    판정: 전부 발행 ' + (okDrain ? '✓' : '✗') + ' / 부하 중 서버 응답 p95 ' + pct(0.95).toFixed(0) + 'ms ' + (okLag ? '✓ (막힘 없음)' : '✗'));
  child.kill();
  process.exit(okDrain && okLag ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
