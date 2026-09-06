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
  CL.rememberLocal = function (rec, packed, result, opt) {
    const o = opt || {};
    const list = JSON.parse(lsGet(STORE.mine, '[]'));
    list.unshift({
      packed: packed, score: result.score, lines: result.lines, pieces: result.pieces,
      ticks: result.ticks, mode: rec.mode, level: rec.level, g20: !!rec.g20, at: Date.now(),
      share: null, localOnly: !!o.localOnly,
    });
    lsSet(STORE.mine, JSON.stringify(list.slice(0, 40)));
    renderMine();
  };
  /** 오프라인 종료 시의 유일한 안내 — 공유 단계는 아예 띄우지 않는다 (game.js:onFinish) */
  CL.localOnlyNote = function () { toast(L.t('mine.savedLocal')); };
  function patchLocal(packed, share) {
    const list = JSON.parse(lsGet(STORE.mine, '[]'));
    for (let i = 0; i < list.length; i++) if (!list[i].share && list[i].packed === packed) { list[i].share = share; break; }
    lsSet(STORE.mine, JSON.stringify(list));
    renderMine();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** queued 로 접수된 제출을 폴링해서 최종 결과 모양으로 바꿔준다. */
  async function awaitVerification(share, initial) {
    const eta = (initial.queue && initial.queue.etaMs) || 0;
    const depth = (initial.queue && initial.queue.pos) || 0;
    const deadline = Date.now() + Math.min(300000, Math.max(45000, eta * 4 + depth * 4000));
    for (let i = 0; ; i++) {
      await sleep(i === 0 ? 1200 : 2500);
      const g = await req('GET', '/api/replay/' + share);
      if (g.status === 200 && g.json) {
        if (g.json.status === 'rejected') return { error: 'rejected', code: g.json.reject, share: share };
        if (!g.json.queued) {
          patchLocal(initial.packed, share);
          const rk = g.json.rank || {};
          return {
            status: g.json.status, share: share, url: '/r/' + share,
            rank: rk.atSubmit, total: rk.total, bestRank: rk.best, isTop: rk.atSubmit === 1,
            flags: g.json.flags || [], hardFlags: g.json.hardFlags || [], softFlags: g.json.softFlags || [],
            metrics: g.json.metrics || {}, displayName: g.json.displayName || null,
            codename: g.json.codename || null, polled: i + 1,
          };
        }
        if (CL.onQueue) CL.onQueue({ pos: (g.json.queue && g.json.queue.pos) || 0, etaMs: g.json.queue && g.json.queue.etaMs, tier: g.json.queue && g.json.queue.tier });
      }
      if (Date.now() > deadline) return { status: 'queued', share: share, url: '/r/' + share, pending: true };
    }
  }

  /** 기기 태그(자가 신고 · 표시 전용). 서버는 이 값을 믿지 않고 판정에도 쓰지 않는다.
   *  raw UA 는 보내지 않는다 — 분류만 보낸다(UA 는 추적 재료로 쓸 수 있어서). */
  async function deviceInfo() {
    const out = {
      os: 'unknown', cls: 'unknown', src: 'unknown',
      cores: navigator.hardwareConcurrency || null, mem: navigator.deviceMemory || null,
      tp: navigator.maxTouchPoints || 0,
      vmin: Math.min((screen && screen.width) || 0, (screen && screen.height) || 0) || null,
    };
    const ua = String(navigator.userAgent || '');
    const uad = navigator.userAgentData || null;
    if (uad && typeof uad.platform === 'string') {
      const p = String(uad.platform).toLowerCase();
      out.os = /android/.test(p) ? 'android' : /ios/.test(p) ? 'ios'
        : /chrome ?os|chromium os/.test(p) ? 'chromeos' : /win/.test(p) ? 'windows'
          : /mac/.test(p) ? 'macos' : /linux/.test(p) ? 'linux' : 'other';
      out.src = 'ua-ch';
      if (typeof uad.mobile === 'boolean' && uad.mobile && out.cls === 'unknown') out.os = out.os === 'unknown' ? 'android' : out.os;
    } else if (/android/i.test(ua)) { out.os = 'android'; out.src = 'ua'; }
    else if (/iphone|ipad|ipod/i.test(ua)) { out.os = 'ios'; out.src = 'ua'; }
    /* iPadOS 13+ 는 일부러 Mac 처럼 말한다 — 터치 포인트가 있는 맥intosh 는 사실상 아이패드 */
    else if (/macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) { out.os = 'ios'; out.src = 'ua'; }
    else if (/windows/i.test(ua)) { out.os = 'windows'; out.src = 'ua'; }
    else if (/cros|x86_64.*chrome/i.test(ua)) { out.os = 'chromeos'; out.src = 'ua'; }
    else if (/mac os x|macintosh/i.test(ua)) { out.os = 'macos'; out.src = 'ua'; }
    else if (/linux|x11/i.test(ua)) { out.os = 'linux'; out.src = 'ua'; }
    else if (ua) { out.os = 'other'; out.src = 'ua'; }

    const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    const coarse = mq('(pointer: coarse)'), fine = mq('(pointer: fine)');
    if (coarse && !fine) out.cls = (out.vmin && out.vmin >= 600) ? 'tablet' : 'phone';
    else if (fine && !coarse) out.cls = 'desktop';
    else if (fine && coarse) out.cls = 'hybrid';
    return out;
  }

  /* 브랜드명은 번역하지 않는다(어디서든 같은 고유명사). 분류 단어만 i18n 키다. */
  const DEV_LABEL = { android: 'Android', ios: 'iPhone/iPad', windows: 'Windows', macos: 'macOS', linux: 'Linux', chromeos: 'ChromeOS', other: '', unknown: '' };
  function devTag(d) {
    if (!d || d.os === 'unknown' || d.os === 'other') return '';
    const clsKey = d.cls === 'phone' ? 'dev.phone' : d.cls === 'tablet' ? 'dev.tablet'
      : d.cls === 'desktop' ? 'dev.desktop' : d.cls === 'hybrid' ? 'dev.hybrid' : null;
    return '<span class="dev" title="' + esc(L.t('dev.hint')) + '">' + esc(DEV_LABEL[d.os] || '') +
      (clsKey ? ' · ' + esc(L.t(clsKey)) : '') + '</span>';
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
      device: await deviceInfo(),        /* 표시 전용. 서명 페이로드(digest)와 무관해서 검증에 영향 없음 */
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
    const out = Object.assign({ httpStatus: r.status }, r.json || { error: 'unknown' });
    if (r.status === 202 && out.share) {
      out.packed = info.packed;
      if (CL.onQueue) CL.onQueue({ pos: (out.queue && out.queue.pos) || 0, etaMs: out.queue && out.queue.etaMs, tier: out.tier });
      return awaitVerification(out.share, out);
    }
    return out;
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
  /** 재현/실측 대비 전용 — HUD(fmtTime) 와 **같은 얼굴**(m:ss.s)이어야 눈으로 비교가 된다. */
  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const neg = ms < 0, s = Math.abs(ms) / 1000;
    const m = Math.floor(s / 60), r = s - m * 60;
    return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
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
    /* 오프라인(file://)에서는 제출 버튼이 없다. 그런데 이름 칸만 띄우면
       "이름을 썼는데 어디에 쓰이나" 가 되므로, 줄 itself 을 내린다. */
    const idRow = offline ? '' : '<div class="sb-row">' +
      '<label>' + esc(L.t('submit.name')) +
      ' <input id="subName" maxlength="24" value="' + esc(savedName) + '" placeholder="' + esc(L.t('submit.namePh')) + '"></label>' +
      '<label class="chk"><input id="subReveal" type="checkbox" ' + (reveal ? 'checked' : '') + '> ' + esc(L.t('submit.reveal')) + '</label>' +
      '</div>';
    box.innerHTML =
      idRow +
      /* 링크를 여는 사람에게 이름이 보인다는 것을 "만들고 나서"가 아니라 "만들기 전에" 알려야 한다. */
      (offline ? '' : '<div class="sb-warn">' + esc(L.t('submit.nameWarn')) + '</div>') +
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
      /* 워커 큐에 들어갔으면 대기 위치를 계속 갱신해 보여준다 */
      CL.onQueue = function (qi) {
        if (!qi) return;
        out.innerHTML = '<div class="res warn queueing">' + esc(L.t('submit.queuedN', {
          pos: (qi.pos || 0) + 1, sec: Math.max(1, Math.round((qi.etaMs || 3000) / 1000)),
        })) + '</div>';
      };
      const res = await CL.submit({
        packed: info.packed, session: info.session, displayName: name || null,
        reveal: rv, challengeOf: info.challengeOf,
      });
      CL.onQueue = null;
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
    if (res.pending) {
      out.innerHTML = '<div class="res warn">' + esc(L.t('submit.stillQueued')) + ' <a href="/r/' + esc(res.share) + '">' + esc(L.t('replay.watch')) + '</a></div>';
      return;
    }
    const statusLine = res.status === 'flagged'
      ? '<div class="res warn">' + esc(L.t('submit.flagged')) + ' <code>' + esc(flagText(res.hardFlags || res.flags)) + '</code></div>'
      : '<div class="res ok">' + esc(L.t('submit.verified')) + '</div>' +
      ((res.softFlags && res.softFlags.length) ? '<div class="res note">' + esc(L.t('submit.soft')) + ' <code>' + esc(flagText(res.softFlags)) + '</code></div>' : '');
    /* 방금 발행된 기록은 보드와 명예의 전당 둘 다에 영향 준다 — 둘 다 새로 고친다 (하나는 켜 놓고 안 하면 빈 채로 남아 있다) */
    CL.loadBoard(true);
    CL.loadHof(true);
    const rank = res.rank
      ? '<div class="rank">' + esc(L.t('submit.rank', { rank: res.rank, total: res.total })) +
      (res.isTop ? ' <b>' + esc(L.t('submit.newTop')) + '</b>' : '') + '</div>' : '';
    const timeLine = (res.time && res.time.shown && res.time.realMs != null)
      ? '<div class="res note">' + esc(L.t('time.pair', {
        sim: fmtMs(res.time.simMs), real: fmtMs(res.time.realMs), delta: fmtMs(Math.abs(res.time.deltaMs || 0)),
      })) + ' <span class="muted">' + esc(L.t('time.pairHint')) + '</span></div>'
      : '';
    out.innerHTML = statusLine + rank + timeLine +
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
      (heldMs > 60000 ? ' · ' + esc(L.t('board.hold1', { time: fmtDur(heldMs) })) : '') +
      ' ' + devTag(d.device) + '</span>' +
      (who ? '' : '') +
      '<span class="grow"></span>' +
      (d.mode !== 'marathon' || d.level > 1 ? '<span class="tag">' + esc(d.mode) + (d.level > 1 ? ' Lv' + d.level : '') + (d.g20 ? ' 20G' : '') + '</span>' : '') +
      '<button class="btn tiny" id="rpChal">' + esc(L.t('replay.challenge')) + '</button>' +
      (d.fp && me && d.fp === me.fp ? '<button class="btn tiny ghost" id="rpHide">목록에서 숨기기</button>' : '') +
      '<button class="btn tiny ghost" id="rpExit">' + esc(L.t('replay.exit')) + '</button></div>' +
      /* 검증된 기록에만 붙는 대비 라인 — 순위 지표(재현)를 교체하는 것이 아니라 나란히 보여주는 것이다. */
      (function () {
        const t = d.time || {};
        if (!t.shown || t.realMs == null) return '';
        return '<div class="rp-timing"><b>' + esc(L.t('time.pair', {
          sim: fmtMs(t.simMs), real: fmtMs(t.realMs), delta: fmtMs(Math.abs(t.deltaMs || 0)),
        })) + '</b> <span class="muted">' + esc(L.t('time.pairHint')) + '</span></div>';
      })() +
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
      const rb = $('wbRefresh'); if (rb) rb.addEventListener('click', function () { CL.loadBoard(true); CL.loadHof(true); });
    }
    const ht = $('hofTabs');
    if (ht) {
      Array.prototype.forEach.call(ht.querySelectorAll('.tab'), function (t) {
        t.addEventListener('click', function () {
          hofKind = t.dataset.k;
          Array.prototype.forEach.call(ht.querySelectorAll('.tab'), function (x) { x.classList.toggle('on', x === t); });
          CL.loadHof();
        });
      });
    }
    const mb = $('mineClear');
    if (mb) mb.addEventListener('click', function () { lsSet(STORE.mine, '[]'); renderMine(); });
    renderMine();
    CL.loadBoard();
    CL.loadHof();
    CL.loadStats();
  };

  /* ---------- 명예의 전당 ---------- */
  let hofKind = 'week';
  /** 기간 키(w:2026-W36 / m:2026-09) → 사람이 읽는 라벨 */
  function periodLabel(key, current) {
    if (current) return L.t('hof.this');
    const m = /^([wm]):(\d{4})-(?:W(\d{1,2})|(\d{1,2}))$/.exec(String(key || ''));
    if (!m) return String(key || '');
    return m[1] === 'w'
      ? L.t('hof.wk', { y: m[2], w: parseInt(m[3], 10) })
      : L.t('hof.mo', { y: m[2], mo: parseInt(m[4], 10) });
  }
  CL.loadHof = async function (force) {
    const list = $('hofList');
    if (!list) return;
    if (!optsRef) { list.innerHTML = '<div class="muted">' + esc(L.t('hof.empty')) + '</div>'; return; }
    const board = optsRef.mode + ':' + optsRef.level + ':' + (optsRef.g20 ? 1 : 0);
    list.innerHTML = '<div class="muted">' + esc(L.t('board.loading')) + '</div>';
    /* 강제 갱신은 캐시를 빗간다 (max-age=60 이어도 "방금" 결과는 바로 보여야 한다) */
    const r = await req('GET', '/api/hof?kind=' + hofKind + '&board=' + encodeURIComponent(board) + '&limit=8' + (force ? '&_=' + Date.now() : ''));
    if (!r || r.offline || r.status !== 200) {
      list.innerHTML = '<div class="muted">' + esc(L.t(r && r.offline ? 'err.network' : 'hof.empty')) + '</div>';
      return;
    }
    const rows = (r.json && r.json.champions) || [];
    const hint = $('hofHint');
    if (hint) {
      const lg = r.json && r.json.longest;
      hint.textContent = lg ? L.t(lg.running ? 'hof.longestNow' : 'hof.longest', { time: fmtShort(lg.held_ms) }) : '';
    }
    if (!rows.length) { list.innerHTML = '<div class="muted">' + esc(L.t('hof.empty')) + '</div>'; return; }
    const time = rows[0].mode === 'sprint';
    list.innerHTML = rows.map(function (c) {
      const val = time ? fmtTime(c.ticks) : (c.score || 0).toLocaleString();
      const sec = time ? (c.score || 0).toLocaleString() + '점' : c.lines + 'L';
      return '<div class="hof-row' + (c.current ? ' now' : '') + '" data-share="' + esc(c.share) + '">' +
        '<span class="per">' + esc(periodLabel(c.period, c.current)) + '</span>' +
        '<span class="cr">🏆</span>' +
        '<span class="who">' + esc(c.codename || L.t('board.anon')) + '<em>' + esc(c.fp ? '·' + ID.fpCode(c.fp) : '') + '</em></span>' +
        '<b class="mono">' + esc(val) + '</b>' +
        '<span class="sub">' + esc(sec) + (c.status === 'flagged' ? ' ⚑' : '') + '</span>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.hof-row'), function (el) {
      el.addEventListener('click', function () { location.href = '/r/' + el.dataset.share; });
    });
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
        devTag(row.device) +
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
      /* 링크가 없는 행이 두 종류다: "제출 안 함으로 둔 판"(나중에) 과 "서버 자체가 없던 판"(미제출).
         전자만 나중에 링크가 붙을 수 있으니 라벨을 구분한다. */
      const tail = r.share ? L.t('replay.watch') : (r.localOnly ? L.t('mine.localOnly') : L.t('submit.later'));
      return '<div class="wb-row' + (r.share ? '' : ' dim') + '" data-share="' + esc(r.share || '') + '">' +
        '<i class="rk">' + esc(r.mode === 'sprint' ? fmtTime(r.ticks) : (r.score || 0).toLocaleString()) + '</i>' +
        '<span class="who">' + esc(L.t('mode.' + r.mode) || r.mode) + (r.level > 1 ? ' Lv' + r.level : '') + '<em>' + esc(new Date(r.at).toLocaleDateString()) + '</em></span>' +
        '<b class="mono">' + r.lines + 'L</b>' +
        '<span class="sub muted">' + esc(tail) + '</span>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.wb-row'), function (el) {
      if (el.dataset.share) el.addEventListener('click', function () { location.href = '/r/' + el.dataset.share; });
    });
  }

  /* ================= 부트 ================= */
  /** 모바일 시트(월드 보드 · 명예의 전당). 데스크톱에서는 .pane 이 display:contents 이고 버튼 자체가 숨겨진다.
   *  일부러 Esc 로는 닫지 않는다: Esc 는 게임 쪽 일시정지와 겹쳐서, 한 키가 두 일을 하게 된다.
   * 손가락 기기에서는 스크림 탭이 자연스러운 동작이라 그쪽으로 둔다. */
  function wirePane() {
    const btn = $('paneBtn'), scrim = $('paneScrim');
    if (!btn) return;
    const setPane = function (open) {
      document.body.classList.toggle('pane-open', !!open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    btn.addEventListener('click', function () { setPane(!document.body.classList.contains('pane-open')); });
    /* SCORE 옆 진입로: 시트를 **여는** 역할만 한다(닫기는 스크림/≡ ). */
    const mine = $('paneMine');
    if (mine) mine.addEventListener('click', function () { setPane(true); });
    if (scrim) scrim.addEventListener('click', function () { setPane(false); });
    /* 시작했는데 시트가 보드를 덮고 있으면 소란스럽다. 버튼 생성 순서에 상관없이 위임으로 잡는다. */
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (t && (t.id === 'ovBtn' || (t.closest && t.closest('#ovBtn')))) setPane(false);
    });
  }

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
    wirePane();
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
    /* data-i18n-title 을 쓰는 요소(langSel, paneBtn)가 있었는데 처리기가 없었다 — 툴팁이 원어로 남아 있었다. */
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-title]'), function (el) {
      el.setAttribute('title', L.t(el.getAttribute('data-i18n-title')));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
      el.setAttribute('placeholder', L.t(el.getAttribute('data-i18n-ph')));
    });
    document.body.dataset.lang = L.get();
  }
  CL.applyI18n = applyI18n;

  /** /r/<share> 로 직접 들어온 경우 키 추출 */
  CL.pathShare = function () {
    const m = /^\/r\/([0-9a-z]{17})$/.exec(location.pathname);
    return m ? m[1] : null;          // 체크섬까지 포함한 형식은 서버가 검사한다
  };
  CL.t = function (k, v) { return L.t(k, v); };
})();
