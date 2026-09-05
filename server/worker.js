/**
 * 검증 워커 (worker_threads)
 *
 * 재시뮬레이션은 CPU를 100% 먹는 작업이고 Node는 요청 처리가 단일 스레드다.
 * 메인 스레드에서 돌리면 900ms짜리 제출 한 건이 정적 파일/보드 API까지 멈춘다.
 * → 그래서 검증은 이렇게 별도 스레드로 보낸다. DB 를 건드리지 않는다(결과만 돌려준다).
 */
'use strict';
const { parentPort } = require('worker_threads');
const RP = require('../replay.js');
const EN = require('../engine.js');
const V = require('./verify.js');

function serialize(v, rec) {
  const e = v.sim;
  return {
    status: v.status,
    code: v.code || null,
    flags: v.flags || [],
    hard: v.hard || [],
    mismatch: v.mismatch || null,
    metrics: v.metrics || {},
    ghost: v.ghost ? JSON.stringify(v.ghost) : null,
    simMs: v.simMs || 0,
    verifyMs: v.verifyMs || 0,
    // 재시뮬이 만들어낸 **실제** 값 (주장값과 일치해야만 발행된다)
    sim: e ? {
      score: e.score, lines: e.lines, pieces: e.pieces, ticks: e.ticks, hash: e.boardHash(),
      tetrises: e.tetrises, tspins: e.tspins, pcs: e.pcs, max_combo: e.maxCombo,
      over_reason: e.overReason || rec.overReason || null,
    } : null,
  };
}

parentPort.on('message', (job) => {
  let out;
  try {
    const rec = RP.unpack(job.packed);
    const v = V.verify(rec, { issuedAt: job.issuedAt, now: Date.now(), ipHash: job.ipHash });
    out = { id: job.id, ok: true, result: serialize(v, rec) };
  } catch (e) {
    out = { id: job.id, ok: false, error: String((e && e.message) || e) };
  }
  parentPort.postMessage(out);
});

parentPort.postMessage({ hello: true, hz: EN.HZ });
