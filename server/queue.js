/**
 * 검증 대기열 — 우선순위는 "점수 순"이 아니라 **티어 + 대기 시간(aging)** 이다.
 *
 * 왜 점수 순이 아닌가:
 *   주장 점수를 우선순위 키로 쓰면, 가짜 고득점을 찍어내면 남들을 제치고 앞줄에 설 수 있다.
 *   검증 비용은 가짜든 진짜든 똑같이 들기 때문에, 순번 특혜는 그대로 어뷰지가 된다.
 *
 * 대신:
 *   tier 0 (우선) : 이미 검증 이력이 있고(rejects 0) 이번 제출이 보드 상위권에 들 것으로 보이는 건
 *                  → "세계 신기록 행진" 은 즉시 확인되는 게 사용자 경험이 가장 좋다
 *   tier 1 (보통) : 나머지는 전부 여기
 *   tier 2 (저속) : 계산이 비싼 장시간 판(1시간 초과) — 한 건이 큐를 다 먹지 못하게 뒤로
 *   aging         : 90초 이상 대기하면 자동으로 tier 0 위로 올린다 → 어떤 티어도 굶지 않는다
 *   티어 안은 FIFO(도착 순) — 안에서 순위 키를 두면 또 같은 구멍이 뚫린다.
 *
 * 대기열은 메모리지만 **행은 DB 에 queued 로 먼저 박혀 있다**. 프로세스가 죽으면 recover() 가 주워온다.
 */
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const CFG = require('./config');
const DB = require('./db');

const WORKER_FILE = path.join(__dirname, 'worker.js');
const PROMOTE_MS = parseInt(process.env.NT_PROMOTE_MS || '90000', 10);
const MAX_ATTEMPTS = 3;
const COST_TICKS = 60 * 60 * 60;      // 1시간(틱) 초과 = 저속 레인

let boardCache = { at: 0, map: new Map() };
function boardThreshold(board) {
  const now = Date.now();
  if (now - boardCache.at > 5000) { boardCache = { at: now, map: new Map() }; }
  if (boardCache.map.has(board)) return boardCache.map.get(board);
  const rows = DB.listBoard(board, { limit: 10 });
  let th = null;
  if (rows.length >= 10) th = DB.metricOf(DB.boardParts(board).mode) === 'time' ? rows[9].ticks : rows[9].score;
  else if (rows.length) th = DB.metricOf(DB.boardParts(board).mode) === 'time' ? rows[rows.length - 1].ticks : rows[rows.length - 1].score;
  boardCache.map.set(board, th);
  return th;
}
function ownerStats(fp) {
  if (!fp) return { verified: 0, rejected: 0 };
  const r = DB.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('verified','flagged') THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) bad
    FROM runs WHERE fp = ?`).get(fp);
  return { verified: r.ok || 0, rejected: r.bad || 0 };
}

/** 제출 접수 시점에(계산 없이) 티어를 정한다 */
function tierOf(o) {
  if ((o.ticks || 0) > COST_TICKS) return 2;
  const th = boardThreshold(o.board);
  const time = DB.metricOf(o.mode) === 'time';
  let beats = false;
  if (th == null) beats = true;                              // 보드가 비어 있음 = 무조건 상위권
  else beats = time ? (o.ticks < th) : (o.score > th);
  const rep = ownerStats(o.fp);
  if (beats && rep.verified > 0 && rep.rejected === 0) return 0;
  return 1;
}

class VerifyQueue {
  constructor() {
    this.n = CFG.LIMITS.workers;
    this.cap = CFG.LIMITS.queueCap;
    this.q = [[], [], []];
    this.all = new Map();
    this.workers = [];
    this.idle = [];
    this.onDone = null;
    this.started = false;
    this.stat = { done: 0, rejected: 0, failed: 0, simMsSum: 0, simMsMax: 0, waitedSum: 0, busyMax: 0, depthMax: 0, waitMsMax: 0 };
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.n; i++) this._addWorker(i);
  }
  _addWorker(i) {
    let w;
    try { w = new Worker(WORKER_FILE); }
    catch (e) { console.error('[queue] 워커 생성 실패:', e.message); return; }
    const slot = { w, job: null };
    w.on('message', (msg) => {
      if (!msg || msg.hello) return;
      const job = slot.job; slot.job = null;
      this.idle.push(slot);
      if (job) this._finish(job, msg);
      this._pump();
    });
    w.on('error', (err) => {
      console.error('[queue] 워커 죽음 #' + i + ':', err.message);
      const job = slot.job; slot.job = null;
      const at = this.workers.indexOf(slot);
      if (at >= 0) this.workers.splice(at, 1);
      this.started = this.workers.length > 0;        // _addWorker 에서 다시 true 로 만든다
      if (job) this._retry(job, String(err.message));
      this._addWorker(i);
      this._pump();
    });
    this.workers.push(slot);
    this.idle.push(slot);
  }

  size() { return this.all.size; }

  /** @returns {{ok:boolean, tier:number, pos:number, reason?:string, etaMs?:number}} */
  add(job) {
    this.start();
    if (this.size() >= this.cap) return { ok: false, reason: 'queue-full', tier: 1, pos: this.size() };
    if (job.tier == null) job.tier = tierOf({ board: job.board, mode: job.mode, score: job.score, ticks: job.ticks, fp: job.fp });
    job.enq = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    this.q[job.tier].push(job);
    this.all.set(job.id, job);
    this._pump();
    const p = this.position(job.id);
    return { ok: true, tier: job.tier, pos: p.pos, etaMs: p.etaMs };
  }

  position(id) {
    const job = this.all.get(id);
    let tier = job ? job.tier : 1;
    if (job && Date.now() - job.enq > PROMOTE_MS) tier = 0;
    let pos = 0, cost = 0;
    for (let t = 0; t <= 2; t++) {
      for (const j of this.q[t]) {
        if (j === job) continue;
        const aged = Date.now() - j.enq > PROMOTE_MS ? 0 : t;
        if (aged < tier || (aged === tier && j.enq < (job ? job.enq : 0))) { pos++; cost += (j.ticks || 6000); }
      }
    }
    const busy = this.workers.length - this.idle.length;
    const etaMs = Math.round(cost * CFG.LIMITS.etaPerTick * 1000 / Math.max(1, this.workers.length) + busy * 300);
    return { pos, tier, etaMs, depth: this.depths(), busy, workers: this.workers.length };
  }
  depths() { return { t0: this.q[0].length, t1: this.q[1].length, t2: this.q[2].length }; }

  /**
   * 고르기 전에 기아 방지를 먼저 한다: PROMOTE_MS 보다 오래 기다린 건은 티어가 몇이든
   * tier 0 맨 앞으로 올린다. (먼저 tier0 를 보고 없어야_promote_ 하는 식이면
   * 우선 티어가 계속 공급되는 동안 저속 건이 영구히 굶는다.)
   */
  _pick() {
    const now = Date.now();
    for (let t = 1; t <= 2; t++) {
      const aged = [];
      for (let i = 0; i < this.q[t].length; i++) {
        if (now - this.q[t][i].enq > PROMOTE_MS) aged.push(this.q[t].splice(i--, 1)[0]);
      }
      if (aged.length) this.q[0] = aged.concat(this.q[0]);
    }
    for (let t = 0; t <= 2; t++) if (this.q[t].length) return this.q[t].shift();
    return null;
  }

  _pump() {
    this.stat.busyMax = Math.max(this.stat.busyMax, this.workers.length - this.idle.length);
    this.stat.depthMax = Math.max(this.stat.depthMax, this.all.size);
    while (this.idle.length) {
      const job = this._pick();
      if (!job) return;
      if (job.id) { try { DB.bumpAttempt(job.id); } catch (e) { } }
      const slot = this.idle.pop();
      slot.job = job;
      slot.w.postMessage({ id: job.id, packed: job.packed, issuedAt: job.issuedAt, ipHash: job.ipHash });
    }
  }

  _retry(job, why) {
    if (job.attempts >= MAX_ATTEMPTS) {
      this.all.delete(job.id);
      this.stat.failed++;
      if (this.onDone) this.onDone(job, { status: 'rejected', code: 'worker-failed:' + why });
      return;
    }
    job.tier = 1;
    this.q[job.tier].push(job);
  }

  _finish(job, msg) {
    this.all.delete(job.id);
    if (!msg.ok) { this.stat.failed++; return this._retry(job, msg.error || 'error'); }
    const r = msg.result;
    if (r.status === 'rejected') this.stat.rejected++; else this.stat.done++;
    this.stat.simMsSum += r.simMs || 0;
    this.stat.simMsMax = Math.max(this.stat.simMsMax, r.simMs || 0);
    const waited = Date.now() - job.enq;
    this.stat.waitedSum += waited;
    this.stat.waitMsMax = Math.max(this.stat.waitMsMax, waited);
    if (this.onDone) this.onDone(job, r);
  }

  /** 재시작/크래시 복구 — DB 에 queued/verifying 으로 남아 있는 행을 다시 담는다 */
  recover() {
    const rows = DB.pendingRuns(this.cap);
    let n = 0;
    for (const row of rows) {
      const job = {
        id: row.id, packed: row.replay, board: row.board, mode: row.mode,
        score: row.score, ticks: row.ticks, fp: row.fp, ipHash: row.ip_hash,
        issuedAt: row.issued_at, tier: row.queue_tier == null ? 1 : row.queue_tier,
        attempts: row.attempts || 0,
      };
      if (this.size() >= this.cap) break;
      job.enq = Date.now();
      job.attempts++;
      this.q[job.tier].push(job);
      this.all.set(job.id, job);
      n++;
    }
    if (n) { console.log('[queue] 미완료 검증 ' + n + '건 복구'); this.start(); this._pump(); }
    return n;
  }

  info() {
    const s = this.stat;
    return {
      workers: this.workers.length,
      busy: this.workers.length - this.idle.length,
      depth: this.depths(),
      waiting: this.all.size,
      done: s.done,
      rejected: s.rejected,
      failed: s.failed,
      simAvgMs: s.done + s.rejected ? +(s.simMsSum / Math.max(1, s.done + s.rejected)).toFixed(1) : 0,
      simMaxMs: s.simMsMax,
      busyMax: s.busyMax, depthMax: s.depthMax, waitMsMax: s.waitMsMax,
      waitAvgMs: (s.done + s.rejected) ? +(s.waitedSum / (s.done + s.rejected)).toFixed(0) : 0,
      promoteMs: PROMOTE_MS,
      cap: this.cap,
    };
  }
}

const queue = new VerifyQueue();
module.exports = { queue, tierOf, boardThreshold, ownerStats, PROMOTE_MS, COST_TICKS };
