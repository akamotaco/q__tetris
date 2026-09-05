/**
 * NEON TETRIS — 신원 표기 (클라임/서버 공용, 순수)
 *
 *  · fp(지문) = 기기 공개키 SPKI-DER 의 SHA-256 앞 8바이트 → base32 5자 + 체크섬 1자
 *    같은 계산을 브라우저(WebCrypto)와 서버(node:crypto)가 동일하게 한다 → 서명 소유권 검증의 기준.
 *  · 코드네임은 사용자 입력 없이 지문에서 결정적으로 파생한다 (BIP39 식: 고정 풀 + 전수 감사).
 *  · ipMask: 서버 관측값 앞 두 자리만 노출. 같다고 같은 사람, 다르다고 다른 사람이 아니다(보조 증거일 뿐).
 *  · ALPHA = 31자(i,o,l,u,9 제외): o/0 l/1 9/g 혼동 회피 + 모음 조합으로 욕설이 되는 경우 회피
 *  · 마지막 1자는 체크섬 → 손으로 옮겨 적을 때 오타를 그 자리에서 알 수 있다 (BIP39과 같은 동기)
 *
 * 이 파일은 클라이언트에도 로드되므로 서버 비밀에 의존하면 안 된다.
 * ⚠ 풀(KO_A/KO_B/EN_A/EN_B)과 ALPHA는 **동결**한다. 바꾸면 같은 지문의 코드네임이 모두 바뀌고,
 *   과거 공유 페이지의 표기가 달라진다. 추가/변경은 반드시 버전을 나누어 한다. (Docker namesgenerator의
 *   "officially frozen" 운용을 그대로 따른다.)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisIdentity = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** i,o,l,u,9 제외 — o/0, l/1, 9 혼동 + 모음 조합 욕설 회피 */
  const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz';
  const BASE = ALPHA.length;              // 31
  const FP_LEN = 5;

  /** 감사(audit)용: 이 부분 문자열을 만드는 조합은 풀에서 제외한다. */
  const BLOCK = [
    // 한글
    '시발', '시팔', '병신', '창녀', '개새', 'fuck', '십8', '노무', '지랄', 'ssibal',
    // 라틴
    'fuck', 'shit', 'bitch', 'whore', 'cum', 'nazi', 'kike', 'retard', 'tranny',
    'fag', 'dyke', 'cock', 'puss', 'anal', 'rape', 'nigger', 'spic', 'gook',
  ];

  const KO_A = ['달빛', '번개', '얼음', '네온', '보라', '은하', '유성', '폭죽', '수정', '회오리',
    '별똥', '안개', '왕관', '돌풍', '먹구름', '북극', '여명', '소용돌이', '전구', '무지개'];
  const KO_B = ['수달', '여우', '고래', '매', '다람쥐', '문어', '두루미', '고슴도치', '판다', '늑대',
    '참수리', '거북', '토끼', '고양이', '하마', '코끼리', '비둘기', '당나귀', '밍크', '올빼미'];

  const EN_A = ['amber', 'brave', 'calm', 'cosmic', 'crisp', 'dense', 'eager', 'fuzzy', 'gentle', 'hollow',
    'iron', 'jolly', 'keen', 'lunar', 'mellow', 'nimble', 'noble', 'quiet', 'royal', 'swift',
    'tidal', 'urban', 'vivid', 'zesty'];
  const EN_B = ['cedar', 'comet', 'delta', 'ember', 'falcon', 'flint', 'garnet', 'harbor', 'heron', 'ivory',
    'jetty', 'kelp', 'lantern', 'maple', 'meadow', 'nimbus', 'onyx', 'otter', 'pebble', 'prism',
    'quartz', 'raven', 'tundra', 'vessel'];

  /** 풀 전수 감사 — 조합이 금지 문자열을 만드는지 검사 (400+576개라 전부 눈으로 확인 가능) */
  function audit() {
    const bad = [];
    const sets = [[KO_A, KO_B], [EN_A, EN_B]];
    for (const [A, B] of sets) {
      for (const a of A) for (const b of B) {
        const s = (a + b).toLowerCase();
        for (const w of BLOCK) if (w.length > 2 && s.includes(w)) bad.push(a + '+' + b + ' → ' + w);
      }
    }
    if (new Set(KO_A).size !== KO_A.length) bad.push('KO 형용어 중복');
    if (new Set(KO_B).size !== KO_B.length) bad.push('KO 명사 중복');
    if (KO_A.some(w => w.length > 4)) bad.push('KO 형용어 4자 초과: ' + KO_A.filter(w => w.length > 4));
    if (KO_B.some(w => w.length > 4)) bad.push('KO 명사 4자 초과: ' + KO_B.filter(w => w.length > 4));
    const sorted = arr => arr.join() === arr.slice().sort().join();
    if (!sorted(EN_A) || !sorted(EN_B)) bad.push('EN 풀이 정렬되지 않음 (BIP39 관례)');
    return bad;
  }

  function b32(bytes, n) {
    let out = '', acc = 0, bits = 0;
    for (const byte of bytes) {
      acc = (acc << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; out += ALPHA[(acc >>> bits) % BASE]; }
    }
    while (out.length < n) { out += ALPHA[acc % BASE]; acc = (acc * 7 + 13) >>> 0; }
    return out.slice(0, n);
  }

  /** 체크섬 1문자: 오타/오독으로 남의 ID에 붙는 사고 방지 (BIP39 checksum과 같은 동기) */
  function checkChar(code) {
    let sum = 0;
    for (let i = 0; i < code.length; i++) sum += ALPHA.indexOf(code[i]) * (i + 2);
    return ALPHA[sum % BASE];
  }
  function fpFromHash(hex) {
    const bytes = [];
    for (let i = 0; i < 8; i += 2) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
    const base = b32(bytes, FP_LEN);
    return { fp: base + checkChar(base), code: base };
  }

  /** 지문 → 코드네임 (결정적) */
  function codename(fp, lang) {
    let h = 0;
    for (let i = 0; i < fp.length; i++) h = (h * 131 + fp.charCodeAt(i)) >>> 0;
    const ko = (lang || 'ko').toLowerCase().startsWith('ko');
    const A = ko ? KO_A : EN_A, B = ko ? KO_B : EN_B;
    const a = A[h % A.length];
    const b = B[Math.floor(h / 977) % B.length];
    return ko ? a + b : a + '-' + b;
  }

  /**
   * 공개용 IP 마스킹 — "동명이인이 아니다"의 보조 증거로만 쓴다.
   * 같다고 같은 사람, 다르다고 다른 사람이 아니다. 원문은 절대 저장/노출하지 않는다.
   */
  function ipMask(ip) {
    const s = String(ip || '').trim();
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (v4) return v4[1] + '.' + v4[2] + '.xx.xx';
    if (s.includes(':')) {
      const parts = s.split(':');
      return (parts[0] || '0') + ':' + (parts[1] || '0') + ':xxxx:xxxx';
    }
    return 'xx.xx.xx.xx';
  }

  /** 지문 형식 검사 (체크섬 포함) */
  function validFp(fp) {
    const s = String(fp || '');
    if (s.length !== FP_LEN + 1) return false;
    for (const ch of s) if (ALPHA.indexOf(ch) < 0) return false;
    return checkChar(s.slice(0, FP_LEN)) === s[FP_LEN];
  }
  function fpCode(fp) { return String(fp || '').slice(0, FP_LEN); }

  /**
   * 서명 대상 문자열의 표준 형식 — 클라이언트(WebCrypto)와 서버(node:crypto)가
   * 똑같이 만들어야 하므로 한 곳에만 정의한다.
   *   예: authPayload('NTSUB1', [digest])
   *       authPayload('NTMINE1', [fp, nonce])
   */
  function authPayload(prefix, parts) {
    return prefix + '\n' + (parts || []).join('\n');
  }

  return {
    ALPHA: ALPHA, BASE: BASE, FP_LEN: FP_LEN, BLOCK: BLOCK,
    KO_A: KO_A, KO_B: KO_B, EN_A: EN_A, EN_B: EN_B,
    audit: audit, fpFromHash: fpFromHash, checkChar: checkChar, validFp: validFp, fpCode: fpCode,
    codename: codename, ipMask: ipMask, b32: b32, authPayload: authPayload,
  };
});
