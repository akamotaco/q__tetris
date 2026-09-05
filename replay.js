/**
 * NEON TETRIS — 리플레이 코덱 (클라임/서버 공용, 순수)
 *
 * 리플레이 = "시드 + 틱 단위 입력 목록" 만이 게임 결과 전체를 결정한다.
 * 따라서 영상 대신 이 작은 텍스트 하나로 재생·검증·공유가 가능하다.
 *
 * 텍스트 포맷 (':' 구분, URL/DB에 그대로 저장 가능)
 *   NT1 : mode : level : g20 : seed : ticks : score : lines : pieces : hash : payload
 *   payload = "<deltaBase36><액션>" 을 '.' 로 이은 것 (delta = 이전 입력과의 틱 차이)
 *   액션: l/r/d 좌·우·소프트 누름, L/R/D 놓음, c CW, z CCW, f 180, h 하드드롭, o 홀드
 */
(function (root, factory) {
  const eng = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.TetrisEngine;
  const api = factory(eng);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisReplay = api;
})(typeof self !== 'undefined' ? self : globalThis, function (EN) {
  'use strict';

  const VERSION = 'NT1';
  const PRESS = { left: 'l', right: 'r', down: 'd', cw: 'c', ccw: 'z', flip: 'f', hard: 'h', hold: 'o' };
  const REL = { left: 'L', right: 'R', down: 'D' };
  const BY_CODE = {};
  Object.keys(PRESS).forEach(function (a) { BY_CODE[PRESS[a]] = { a: a, k: 1 }; });
  Object.keys(REL).forEach(function (a) { BY_CODE[REL[a]] = { a: a, k: 0 }; });

  /* ---- 입력 목록 <-> 문자열 ---- */
  function encodeInputs(inputs) {
    let prev = 0;
    const out = [];
    for (let i = 0; i < inputs.length; i++) {
      const it = inputs[i];
      const code = it.k ? PRESS[it.a] : REL[it.a];
      if (!code) continue;
      out.push((it.t - prev).toString(36) + code);
      prev = it.t;
    }
    return out.join('.');
  }

  function decodeInputs(payload) {
    const list = [];
    if (!payload) return list;
    let t = 0;
    const parts = String(payload).split('.');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) throw new Error('빈 입력 항목');
      const code = p.charAt(p.length - 1);
      const map = BY_CODE[code];
      if (!map) throw new Error('알 수 없는 액션: ' + code);
      const head = p.slice(0, -1);
      if (!/^[0-9a-z]*$/.test(head)) throw new Error('잘못된 틱 값');
      t += parseInt(head || '0', 36);
      list.push({ t: t, a: map.a, k: map.k });
    }
    return list;
  }

  /* ---- 전체 레코드 ---- */
  function pack(rec) {
    return [
      VERSION, rec.mode, rec.level | 0, rec.g20 ? 1 : 0, rec.seed,
      rec.ticks | 0, rec.score | 0, rec.lines | 0, rec.pieces | 0, rec.hash,
      encodeInputs(rec.inputs || []),
    ].join(':');
  }

  function unpack(text) {
    const p = String(text).trim().split(':');
    if (p.length !== 11) throw new Error('항목 수 불일치');
    if (p[0] !== VERSION) throw new Error('버전 불일치: ' + p[0]);
    const mode = p[1];
    if (!EN.MODES[mode]) throw new Error('알 수 없는 모드: ' + mode);
    const inputs = decodeInputs(p[10]);
    return {
      v: VERSION,
      mode: mode,
      level: parseInt(p[2], 10) || 1,
      g20: p[3] === '1',
      seed: p[4],
      ticks: parseInt(p[5], 10) || 0,
      score: parseInt(p[6], 10) || 0,
      lines: parseInt(p[7], 10) || 0,
      pieces: parseInt(p[8], 10) || 0,
      hash: p[9],
      inputs: inputs,
      lastInputTick: inputs.length ? inputs[inputs.length - 1].t : 0,
    };
  }

  /** 서버가 재시뮬하기 전에 거르는 저비용 형태 검사 */
  const SEED_RE = /^[0-9a-zA-Z_-]{6,64}$/;
  function checkShape(rec, lim) {
    lim = lim || {};
    const maxInputs = lim.maxInputs || 40000;
    const maxTicks = lim.maxTicks || 60 * 60 * 4;      // 4시간
    const errs = [];
    if (rec.v !== VERSION) errs.push('version');
    if (!EN.MODES[rec.mode]) errs.push('mode');
    if (!(rec.level >= 1 && rec.level <= EN.MAX_LEVEL)) errs.push('level');
    if (typeof rec.g20 !== 'boolean') errs.push('g20');
    if (!SEED_RE.test(String(rec.seed))) errs.push('seed');
    if (!(rec.ticks >= 0 && rec.ticks <= maxTicks)) errs.push('ticks');
    if (!(rec.score >= 0 && rec.score <= 1e10)) errs.push('score');
    if (!(rec.lines >= 0 && rec.lines <= 4000)) errs.push('lines');
    if (!(rec.pieces >= 0 && rec.pieces <= 40000)) errs.push('pieces');
    if (!/^[0-9a-z]{4,10}$/.test(String(rec.hash))) errs.push('hash');
    if (!(rec.inputs.length > 0)) errs.push('no-inputs');
    if (rec.inputs.length > maxInputs) errs.push('too-many-inputs');
    let prev = 0;
    for (let i = 0; i < rec.inputs.length; i++) {
      const it = rec.inputs[i];
      if (!(it.t >= prev && it.t >= 1)) { errs.push('inputs-not-increasing'); break; }
      prev = it.t;
    }
    if (prev > rec.ticks + EN.HZ * 2) errs.push('inputs-exceed-ticks');
    return errs;
  }

  /* ---- 지표 ---- */
  function seconds(ticks) { return ticks / EN.HZ; }
  function fmtTime(ticks) {
    const s = ticks / EN.HZ;
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem.toFixed(2);
  }
  function pps(rec) { return rec.ticks ? rec.pieces / seconds(rec.ticks) : 0; }
  function apm(rec) { return rec.ticks ? rec.lines / (seconds(rec.ticks) / 60) : 0; }
  function inpPerSec(rec) { return rec.ticks ? rec.inputs.length / seconds(rec.ticks) : 0; }

  /* ---- 재생용: 틱별 입력 분발 (렌더러가 틱마다 소비) ---- */
  function cursor(rec) {
    const inputs = rec.inputs;
    let i = 0;
    return {
      /** nextTick까지 진행해야 하므로 "t <= tick" 인 입력을 순서대로 반환 */
      take: function (tick) {
        const out = [];
        while (i < inputs.length && inputs[i].t <= tick) out.push(inputs[i++]);
        return out;
      },
      done: function () { return i >= inputs.length; },
      index: function () { return i; },
      seek: function (tick) {
        i = 0;
        while (i < inputs.length && inputs[i].t <= tick) i++;
      },
    };
  }

  return {
    VERSION: VERSION,
    PRESS: PRESS, REL: REL,
    encodeInputs: encodeInputs,
    decodeInputs: decodeInputs,
    pack: pack,
    unpack: unpack,
    checkShape: checkShape,
    seconds: seconds,
    fmtTime: fmtTime,
    pps: pps,
    apm: apm,
    inpPerSec: inpPerSec,
    cursor: cursor,
  };
});
