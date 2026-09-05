/**
 * NEON TETRIS — 클라이언트 측 서버 연결/정체성/공유
 *
 * · 정체성: 최초 1회 ECDSA P-256 키쌍을 만든다. 개인키는 extractable:false 로 IndexedDB 에 들어간다
 *   → 문자열로 꺼내거나 다른 기기로 복사할 수 없고, 오직 "서명"에만 쓸 수 있다. 로그인·비밀번호 없음.
 * · 제출: packed 리플레이 + 서버 넌스에 대한 서명. 서버는 같은 내용을 다시 돌려 점수를 검증한다.
 * · 이름: display_name 은 제출자가 공유를 택한 링크(/r/<share>) 와 내 목록에서만 렌더링된다.
 *   보드 목록을 그리는 코드는 그 응답에 애초에 이름 필드가 없다.
 */
(function () {
  'use strict';
  const RP = window.TetrisReplay;
  const ID = window.TetrisIdentity;
  const L = window.TetrisI18n;
  const EN = window.TetrisEngine;
  const CL = {};
  window.TetrisClient = CL;

  const $ = function (id) { return document.getElementById(id); };
  const isFile = location.protocol === 'file:' || location.protocol === 'blob:';
  const subtle = (window.crypto && window.crypto.subtle) || null;
  const enc = new TextEncoder();

  const STORE = {
    high: 'neon-tetris-high', mode: 'neon-tetris-mode', lang: 'neon-tetris-lang',
    name: 'neon-tetris-name', mine: 'neon-tetris-mine', reveal: 'neon-tetris-reveal',
  };
  function lsGet(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  let me = null;               // { fp, jwk, priv }
  let identFailed = false;
  let hooks = {};              // game.js 로부터 받는 콜백
  let optsRef = null;          // game.js 의 opts 를 참조(모드/레벨)
  let challenge = null;        // {share, ghost, name, board}
  let raceIdx = 0;
  let stats = null;

  const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ================= IndexedDB (개인키는 여기만) ================= */
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const rq = indexedDB.open('neon-tetris', 1);
      rq.onupgradeneeded = function () { if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbReq(db, mode, key, val) {
    return new Promise(function (res, rej) {
      const tx = db.transaction('kv', mode);
      const st = tx.objectStore('kv');
      const rq = key === undefined ? st.getAllKeys() : (mode === 'readonly' ? st.get(key) : st.put(val, key));
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  async function idbGet(k) { try { const db = await idbOpen(); return await idbReq(db, 'readonly', k); } catch (e) { return null; } }
  async function idbSet(k, v) { try { const db = await idbOpen(); await idbReq(db, 'readwrite', k, v); return true; } catch (e) { return false; } }

  function toHex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  function toB64(buf) {
    const b = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin);
  }

  async function identity() {
    if (me || identFailed || !subtle) return me;
    try {
      let kp = await idbGet('ec');
      if (!kp || !kp.privateKey || !kp.publicKey) {
        kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        await idbSet('ec', kp);
      }
      const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
      const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      const digest = await crypto.subtle.digest('SHA-256', spki);
      const fp = ID.fpFromHash(toHex(digest)).fp;
      me = { fp: fp, jwk: jwk, priv: kp.privateKey };
      const chip = $('meChip');
      if (chip) {
        chip.innerHTML = '<b>' + esc(ID.codename(fp, L.get())) + '</b><span>·' + esc(fp) + '</span>';
        chip.title = L.get() === 'ko' ? '이 기기에서 만든 서명 ID 입니다. 로그인 없이 기록 소유를 증명할 때 쓰입니다.' : '';
      }
    } catch (e) {
      identFailed = true;
      me = null;
    }
    return me;
  }
  async function sign(payload) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, me.priv, enc.encode(payload));
    return toB64(sig);
  }
  /** 서버의 ID.authPayload 와 완전히 같은 형태여야 한다 */
  const payloadOf = ID.authPayload;

  /* ================= API ================= */
  async function req(method, path, body, ms) {
    if (isFile) return { offline: true };
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ms || 9000);
    try {
      const res = await fetch(path, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        keepalive: method === 'POST' && path.indexOf('/api/play/') === 0,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { }
      return { status: res.status, json: json, text: text };
    } catch (e) {
      return { offline: true, error: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 판 시작 전 1회용 시드 발급. 실패하면 null → 오프라인 플레이(제출만 불가) */
  CL.session = async function (o) {
    const r = await req('POST', '/api/session', {
      mode: o.mode, level: o.level, g20: o.g20, fp: me ? me.fp : null, lang: L.get(),
    });
    if (r.offline || r.status !== 200) {
      if (r.status === 403) toast(L.t('err.banned'));
      else if (r.status === 429) toast(L.t('err.rate'));
      setNet(false);
      return null;
    }
    setNet(true);
    return r.json;
  };

  CL.getReplay = async function (share) {
    const r = await req('GET', '/api/replay/' + encodeURIComponent(share));
    if (r.offline || r.status !== 200) { toast(r.offline ? L.t('err.network') : (r.json && r.json.error) || 'error'); return null; }
    setNet(true);
    return r.json;
  };

  CL.playbackPing = function (share) { req('POST', '/api/play/' + share + '?via=share&v=' + encodeURIComponent(CL_VERSION)); };

  /* ================= 제출 ================= */
  CL.rememberLocal = function (rec, packed, result) {
    const list = JSON.parse(lsGet(STORE.mine, '[]'));
    list.unshift({
      packed: packed, score: result.score, lines: result.lines, pieces: result.pieces,
      ticks: result.ticks, mode: rec.mode, level: rec.level, g20: !!rec.g20, at: Date.now(), share: null,
    });
    lsSet(STORE.mine, JSON.stringify(list.slice(0, 40)));
    renderMine();
  };
  function patchLocal(packed, share) {
    const list = JSON.parse(lsGet(STORE.mine, '[]'));
    for (let i = 0; i < list.length; i++) if (!list[i].share && list[i].packed === packed) { list[i].share = share; break; }
    lsSet(STORE.mine, JSON.stringify(list));
    renderMine();
  }

  CL.submit = async function (info) {
    if (!info.session) return { error: 'offline' };
    const rec = RP.unpack(info.packed);
    const digest = await sha256hex(RP.canonical(rec));
    const nonce = info.session.nonce || '';
    const body = {
      replay: info.packed, nonce: nonce, lang: L.get(), clientVer: CL_VERSION,
      displayName: info.displayName || null, reveal: info.reveal !== false,
      challengeOf: info.challengeOf || null,
    };
    if (me) {
      body.fp = me.fp;
      const payload = payloadOf('NTSUB1', [digest, nonce]);
      const sig = await sign(payload);
      body.owner = { jwk: me.jwk, sig: sig };
    }
    const r = await req('POST', '/api/submit', body, 20000);
    if (r.offline) return { error: L.t('err.network') };
    if (r.status === 200 && r.json && r.json.share) patchLocal(info.packed, r.json.share);
    return Object.assign({ httpStatus: r.status }, r.json || { error: 'unknown' });
  };

  async function sha256hex(str) {
    const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return toHex(h);
  }

  /* ================= 공통 UI 조각 ================= */
  const CL_VERSION = '1.0.0';
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3200);
  }
  function setNet(on) {
    const el = $('netDot');
    if (el) el.classList.toggle('off', !on);
  }
  function fmtTime(ticks) {
    const s = ticks / EN.HZ;
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }
  function flagText(flags) {
    if (!flags || !flags.length) return '';
    return flags.join(', ');
  }

  /* ================= 제출 상자 ================= */
  CL.onSubmitReady = function (info) {
    const box = $('submitBox');
    if (!box) return;
    const offline = !info.session;
    const savedName = lsGet(STORE.name, '');
    const reveal = lsGet(STORE.reveal, '1') !== '0';
    box.classList.remove('hidden', 'done');
    box.innerHTML =
      '<div class="sb-row">' +
      '<label>' + esc(L.t('submit.name')) +
      ' <input id="subName" maxlength="24" value="' + esc(savedName) + '" placeholder="' + esc(L.t('submit.namePh')) + '"></label>' +
      '<label class="chk"><input id="subReveal" type="checkbox" ' + (reveal ? 'checked' : '') + '> ' + esc(L.t('submit.reveal')) + '</label>' +
      '</div>' +
      '<div class="sb-act">' +
      (offline
        ? '<span class="muted">' + esc(L.t('submit.offline')) + '</span>'
        : '<button class="btn primary" id="subGo">' + esc(L.t('submit.go')) + '</button>') +
      '<button class="btn ghost" id="subLater">' + esc(L.t('submit.later')) + '</button>' +
      '</div>' +
      '<div class="sb-out" id="subOut"></div>';
    const later = $('subLater');
    if (later) later.addEventListener('click', function () { box.classList.add('hidden'); });
    const go = $('subGo');
    if (go) go.addEventListener('click', async function () {
      const name = $('subName').value.trim();
      const rv = $('subReveal').checked;
      lsSet(STORE.name, name); lsSet(STORE.reveal, rv ? '1' : '0');
      go.disabled = true;
      go.textContent = L.t('submit.verifying');
      const out = $('subOut');
      out.innerHTML = '<div class="bar indet"></div>';
      const res = await CL.submit({
        packed: info.packed, session: info.session, displayName: name || null,
        reveal: rv, challengeOf: info.challengeOf,
      });
      box.classList.add('done');
      renderSubmitResult(out, res, name, info);
    });
  };

  function renderSubmitResult(out, res, name, info) {
    const go = $('subGo');
    if (go) go.disabled = false;
    if (res.error === 'duplicate') {
      out.innerHTML = '<div class="res warn">' + esc(L.t('submit.duplicate')) +
        (res.of ? ' · <a href="/r/' + esc(res.of) + '">' + esc(res.of) + '</a>' : '') + '</div>';
      return;
    }
    if (res.error || !res.share) {
      out.innerHTML = '<div class="res bad">' + esc(L.t('submit.error')) +
        ' <code>' + esc(res.code || res.why || res.error || res.httpStatus || '?') + '</code>' +
        (res.mismatch ? ' <code>' + esc(res.mismatch.join(',')) + '</code>' : '') + '</div>';
      return;
    }
    const url = location.origin + (location.port ? ':' + location.port : '') + '/r/' + res.share;
    const statusLine = res.status === 'flagged'
      ? '<div class="res warn">' + esc(L.t('submit.flagged')) + ' <code>' + esc(flagText(res.hardFlags || res.flags)) + '</code></div>'
      : '<div class="res ok">' + esc(L.t('submit.verified')) + '</div>' +
      ((res.softFlags && res.softFlags.length) ? '<div class="res note">' + esc(L.t('submit.soft')) + ' <code>' + esc(flagText(res.softFlags)) + '</code></div>' : '');
    const rank = res.rank
      ? '<div class="rank">' + esc(L.t('submit.rank', { rank: res.rank, total: res.total })) +
      (res.isTop ? ' <b>' + esc(L.t('submit.newTop')) + '</b>' : '') + '</div>' : '';
    out.innerHTML = statusLine + rank +
      '<div class="share">' +
      '<label>' + esc(L.t('submit.share')) + '</label>' +
      '<input readonly value="' + esc(url) + '" id="shareUrl"' +
      '<button class="btn tiny" id="copyBtn">' + esc(L.t('submit.copy')) + '</button>' +
      '</div>' +
      '<div class="sb-act"><button class="btn primary" id="watchBtn">' + esc(L.t('submit.watch')) + '</button>' +
      '<button class="btn ghost" id="againBtn">' + esc(L.t('ui.retry')) + '</button></div>';
    const su = $('shareUrl');
    if (su) su.addEventListener('click', function () { su.select(); });
    const cp = $('copyBtn');
    if (cp) cp.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        const i = out.querySelector('.share input'); i.select(); document.execCommand && document.execCommand('copy');
      }
      cp.textContent = L.t('submit.copied');
    });
    const wb = $('watchBtn');
    if (wb) wb.addEventListener('click', function () { location.href = '/r/' + res.share; });
    const ab = $('againBtn');
    if (ab) ab.addEventListener('click', function () {
      const box = $('submitBox'); if (box) box.classList.add('hidden');
      if (hooks.restart) hooks.restart();
    });
  }

  /* ================= 리플레이 바 ================= */
  CL.showReplayBar = function (play, cbs) {
    const bar = $('replayBar');
    if (!bar) return;
    const d = play.data || {};
    const who = d.displayName || d.codename || L.t('board.anon');
    const heldMs = (d.hold || []).reduce(function (a, h) { return a + ((h.until_ms || Date.now()) - h.since); }, 0);
    bar.classList.remove('hidden');
    bar.innerHTML =
      '<div class="rp-head"><b>' + esc(L.t('replay.title')) + '</b>' +
      '<span>' + esc(L.t('replay.by', { who: who })) + ' · ' + (d.score || 0).toLocaleString() +
      ' · ' + (d.lines || 0) + 'L · ' + fmtTime(d.ticks || 0) +
      (d.rank && d.rank.atSubmit ? ' · ' + esc(L.t('board.topAt', { rank: d.rank.atSubmit })) : '') +
      (heldMs > 60000 ? ' · ' + esc(L.t('board.hold1', { time: fmtDur(heldMs) })) : '') + '</span>' +
      (who ? '' : '') +
      '<span class="grow"></span>' +
      (d.mode !== 'marathon' || d.level > 1 ? '<span class="tag">' + esc(d.mode) + (d.level > 1 ? ' Lv' + d.level : '') + (d.g20 ? ' 20G' : '') + '</span>' : '') +
      '<button class="btn tiny" id="rpChal">' + esc(L.t('replay.challenge')) + '</button>' +
      (d.fp && me && d.fp === me.fp ? '<button class="btn tiny ghost" id="rpHide">목록에서 숨기기</button>' : '') +
      '<button class="btn tiny ghost" id="rpExit">' + esc(L.t('replay.exit')) + '</button></div>' +
      '<div class="rp-ctrl">' +
      '<span>' + esc(L.t('replay.speed')) + '</span>' +
      [1, 2, 4].map(function (s) { return '<button class="btn tiny sp" data-s="' + s + '">' + s + '×</button>'; }).join('') +
      '<button class="btn tiny ghost" id="rpBack">⟲</button>' +
      '<div class="rp-track" id="rpTrack"><div class="rp-fill" id="rpFill"></div></div>' +
      '<span id="rpTime" class="mono">0:00 / ' + fmtTime(d.ticks || 0) + '</span>' +
      '</div>';
    Array.prototype.forEach.call(bar.querySelectorAll('.sp'), function (b) {
      b.addEventListener('click', function () {
        if (cbs.onSpeed) cbs.onSpeed(+b.dataset.s);
        Array.prototype.forEach.call(bar.querySelectorAll('.sp'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    const back = $('rpBack'); if (back) back.addEventListener('click', cbs.onRestart);
    const exit = $('rpExit'); if (exit) exit.addEventListener('click', cbs.onExit);
    const chal = $('rpChal'); if (chal) chal.addEventListener('click', function () { location.href = '/?challenge=' + play.share; });
    const hide = $('rpHide');
    if (hide) hide.addEventListener('click', async function () {
      const nonce = 'h' + Date.now();
      hide.disabled = true;
      const r = await req('POST', '/api/hide/' + play.share, {
        fp: me.fp, nonce: nonce, owner: { jwk: me.jwk, sig: await sign(payloadOf('NTHIDE1', [play.share, nonce])) },
      });
      toast((r.json && (r.json.note || r.json.error)) || L.t('err.network'));
      if (r.status !== 200) hide.disabled = false;
    });
    const track = $('rpTrack');
    if (track) track.addEventListener('click', function (e) {
      const r = track.getBoundingClientRect();
      if (cbs.onSeek) cbs.onSeek(Math.max(0, Math.round((e.clientX - r.left) / r.width * play.total)));
    });
    bar.querySelector('.sp[data-s="1"]').classList.add('on');
    CL._total = play.total;
  };
  CL.hideReplayBar = function () { const b = $('replayBar'); if (b) b.classList.add('hidden'); };
  CL.updateProgress = function (ratio) {
    const f = $('rpFill'), t = $('rpTime');
    if (f) f.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    if (t && CL._total) t.textContent = fmtTime(CL._total * ratio) + ' / ' + fmtTime(CL._total);
  };
  CL.replayFinished = function () { toast(L.t('replay.title') + ' ✓'); };

  /* ================= 고스트 레이스 ================= */
  CL.showRaceBar = function (ch) {
    challenge = ch; raceIdx = 0;
    const bar = $('raceBar');
    if (!bar) return;
    bar.classList.remove('hidden');
    bar.innerHTML =
      '<div class="rc-names"><span>' + esc(L.t('race.you')) + '</span><span>' + esc(L.t('race.them', { who: ch.name })) + '</span></div>' +
      '<div class="rc-track"><div class="rc-me" id="rcMe"></div><div class="rc-them" id="rcThem"></div></div>' +
      '<div class="rc-gap mono" id="rcGap"></div>';
  };
  CL.hideRaceBar = function () { const b = $('raceBar'); if (b) b.classList.add('hidden'); challenge = null; };
  function ghostScoreAt(ghost, tick) {
    if (!ghost || !ghost.length) return 0;
    let i = 0;
    while (i < ghost.length - 1 && ghost[i + 1][0] <= tick) i++;
    return ghost[i][0] <= tick ? ghost[i][1] : 0;
  }
  CL.updateRace = function (E) {
    if (!challenge || !challenge.ghost || !challenge.ghost.length) return;
    const mine = E.score, them = ghostScoreAt(challenge.ghost, E.ticks);
    const top = Math.max(mine, them, 1);
    const a = $('rcMe'), b = $('rcThem'), g = $('rcGap');
    if (a) a.style.width = (mine / top * 100) + '%';
    if (b) b.style.width = (them / top * 100) + '%';
    if (g) {
      const d = mine - them;
      g.textContent = (d >= 0 ? '+' : '-') + Math.abs(d).toLocaleString();
      g.classList.toggle('ahead', d >= 0);
    }
  };

  /* ================= 월드 보드 ================= */
  let period = 'all';
  CL.mount = function (h) {
    hooks = h || {};
    optsRef = h.opts;
    const box = $('worldBoard');
    if (box) {
      box.innerHTML =
        '<div class="wb-tabs">' +
        ['all', 'week', 'month'].map(function (p) {
          return '<button class="tab' + (p === period ? ' on' : '') + '" data-p="' + p + '">' + esc(L.t('board.' + p)) + '</button>';
        }).join('') +
        '<span class="grow"></span><button class="btn tiny ghost" id="wbRefresh">↻</button></div>' +
        '<div class="wb-list" id="wbList"><div class="muted">' + esc(L.t('board.loading')) + '</div></div>';
      Array.prototype.forEach.call(box.querySelectorAll('.tab'), function (t) {
        t.addEventListener('click', function () {
          period = t.dataset.p;
          Array.prototype.forEach.call(box.querySelectorAll('.tab'), function (x) { x.classList.toggle('on', x === t); });
          CL.loadBoard();
        });
      });
      const rb = $('wbRefresh'); if (rb) rb.addEventListener('click', function () { CL.loadBoard(true); });
    }
    const mb = $('mineClear');
    if (mb) mb.addEventListener('click', function () { lsSet(STORE.mine, '[]'); renderMine(); });
    renderMine();
    CL.loadBoard();
    CL.loadStats();
  };

  CL.loadBoard = async function (force) {
    if (!optsRef || !$('wbList')) return;
    const board = optsRef.mode + ':' + optsRef.level + ':' + (optsRef.g20 ? 1 : 0);
    let url = '/api/board?mode=' + optsRef.mode + '&level=' + optsRef.level + '&g20=' + (optsRef.g20 ? 1 : 0) + '&limit=10';
    if (period !== 'all') {
      const per = await CL.currentPeriods();
      if (per) url = '/api/period?period=' + encodeURIComponent(period === 'week' ? per.week : per.month) + '&board=' + encodeURIComponent(board) + '&limit=10';
    }
    const r = await req('GET', url + (force ? '&' + Date.now() : ''));
    const list = $('wbList');
    if (!list) return;
    if (r.offline) { list.innerHTML = '<div class="muted">' + esc(L.t('err.network')) + '</div>'; setNet(false); return; }
    setNet(true);
    const rows = period === 'all' ? (r.json && r.json.list) || [] : (r.json && r.json.rows) || [];
    if (!rows.length) { list.innerHTML = '<div class="muted">' + esc(L.t('board.empty')) + '</div>'; return; }
    const time = (r.json && r.json.metric) === 'time' || optsRef.mode === 'sprint';
    list.innerHTML = rows.map(function (row, i) {
      const who = row.codename || L.t('board.anon');
      const fp = row.fp ? '·' + ID.fpCode(row.fp) : '';
      const val = time ? fmtTime(row.ticks) : (row.score || 0).toLocaleString();
      const sec = time ? (row.score || 0).toLocaleString() + '점' : row.lines + 'L · ' + fmtTime(row.ticks);
      return '<div class="wb-row" data-share="' + esc(row.share) + '">' +
        '<i class="rk' + (i === 0 ? ' g' : '') + '">' + (row.rank || i + 1) + '</i>' +
        '<span class="who">' + esc(who) + '<em>' + esc(fp) + '</em></span>' +
        '<b class="mono">' + esc(val) + '</b>' +
        '<span class="sub">' + esc(sec) + '</span>' +
        (row.status === 'flagged' ? '<span class="flag">⚑</span>' : '') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.wb-row'), function (el) {
      el.addEventListener('click', function () { location.href = '/r/' + el.dataset.share; });
    });
    const hold = r.json && r.json.hold && r.json.hold.current;
    const hl = $('wbHold');
    if (hl) {
      if (hold) hl.textContent = L.t('board.hold1', { time: fmtShort(Date.now() - hold.since) });
      hl.style.display = hold ? '' : 'none';
    }
  };
  function fmtDur(ms) {
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return d + 'd ' + (h % 24) + 'h';
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    return m + 'm';
  }
  function fmtShort(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  let periodCache = null;
  CL.currentPeriods = async function () {
    if (periodCache) return periodCache;
    const r = await req('GET', '/api/periods');
    if (r.offline || r.status !== 200) return null;
    periodCache = r.json.current;
    return periodCache;
  };

  CL.loadStats = async function () {
    const r = await req('GET', '/api/stats');
    if (r.offline || r.status !== 200) return;
    stats = r.json;
    setNet(true);
    const el = $('statNet');
    if (el && stats) el.textContent = L.t('stats.players', { n: stats.playersToday || 0, m: stats.netsToday || 0 });
  };

  /* ================= 내 기록 (이 브라우저에만 저장) ================= */
  function renderMine() {
    const list = $('mineList');
    if (!list) return;
    const rows = JSON.parse(lsGet(STORE.mine, '[]'));
    if (!rows.length) { list.innerHTML = '<div class="muted">' + esc(L.t('mine.empty')) + '</div>'; return; }
    list.innerHTML = rows.slice(0, 8).map(function (r) {
      return '<div class="wb-row" data-share="' + esc(r.share || '') + '">' +
        '<i class="rk">' + esc(r.mode === 'sprint' ? fmtTime(r.ticks) : (r.score || 0).toLocaleString()) + '</i>' +
        '<span class="who">' + esc(L.t('mode.' + r.mode) || r.mode) + (r.level > 1 ? ' Lv' + r.level : '') + '<em>' + esc(new Date(r.at).toLocaleDateString()) + '</em></span>' +
        '<b class="mono">' + r.lines + 'L</b>' +
        (r.share ? '<span class="sub">' + esc(L.t('replay.watch')) + '</span>' : '<span class="sub muted">' + esc(L.t('submit.later')) + '</span>') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.wb-row'), function (el) {
      if (el.dataset.share) el.addEventListener('click', function () { location.href = '/r/' + el.dataset.share; });
    });
  }

  /* ================= 부트 ================= */
  CL.init = async function (cfg) {
    const explicit = new URLSearchParams(location.search).get('lang');
    L.set(L.detect([explicit, lsGet(STORE.lang, '')].filter(Boolean)));
    document.documentElement.lang = L.get();
    const sel = $('langSel');
    if (sel) {
      sel.innerHTML = L.LANGS.map(function (l) { return '<option value="' + l + '">' + l.toUpperCase() + '</option>'; }).join('');
      sel.value = L.get();
      sel.addEventListener('change', function () { L.set(sel.value); location.reload(); });
    }
    applyI18n();
    await identity();
    if (!subtle || isFile) {
      const chip = $('meChip');
      if (chip) chip.innerHTML = '<b>' + esc(L.t('submit.offline')) + '</b>';
    }
    return { fp: me ? me.fp : null, lang: L.get() };
  };

  function applyI18n() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      el.textContent = L.t(el.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
      el.setAttribute('placeholder', L.t(el.getAttribute('data-i18n-ph')));
    });
    document.body.dataset.lang = L.get();
  }
  CL.applyI18n = applyI18n;

  /** /r/<share> 로 직접 들어온 경우 키 추출 */
  CL.pathShare = function () {
    const m = /^\/r\/([0-9a-z]{13})$/.exec(location.pathname);
    if (!m) return null;
    const k = m[1];
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += k.charCodeAt(i) * (i + 3);
    return (sum % 36).toString(36) === k[12] ? k : k;   // 체크섬 실패해도 일단 시도(서버가 404)
  };
  CL.t = function (k, v) { return L.t(k, v); };
})();
