/**
 * NEON TETRIS — 로컬라이제이션 (순수, 의존성 0)
 *
 * · 원본 언어는 한국어(ko). 없는 키는 ko 로 폴백한다.
 * · 게임 엔진이 뿜는 라벨(TETRIS, T-SPIN MINI DOUBLE…) 은 "토큰"이라 여기서 표어로 번역한다.
 *   점수 계산에 관여하는 값은 절대 번역하지 않는다 → 검증과 무관.
 * · 언어는 <html lang> 과 body[data-lang] 에 반영되고, 폰트/줄바꿈 규칙이 이를 사용한다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisI18n = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CATALOG = {
    ko: {
      'ov.ready': '줄을 지워 점수를 쌓아보세요. 기록은 서버가 다시 돌려서 검증됩니다.',
      'ov.paused': '일시정지 중',
      'ov.over': '게임 오버',
      'ov.timeup': '시간 종료',
      'ov.finish': '목표 달성!',
      'ov.newbest': '★ 새 최고 점수!',
      'ov.firstbest': '첫 최고 점수 등록!',
      'ov.retry': '다시 도전해볼까요?',
      'ui.start': 'START', 'ui.resume': 'RESUME', 'ui.retry': 'RETRY',
      'mode.marathon': '마라톤', 'mode.sprint': '스프린트 40L', 'mode.ultra': '울트라 2분',
      'ultra.left': '남은 시간',
      'label.SINGLE': '싱글', 'label.DOUBLE': '더블', 'label.TRIPLE': '트리플', 'label.TETRIS': '테트리스',
      'label.T-SPIN': 'T-스핀', 'label.PERFECT CLEAR': '퍼펙트 클리어', 'label.NEW RECORD': '신기록',
      'board.title': '월드 레코드', 'board.me': '내 기록', 'board.loading': '불러오는 중…',
      'board.empty': '아직 기록이 없습니다. 첫 번째가 되어보세요.',
      'board.rank': '순위', 'board.player': '플레이어', 'board.score': '점수', 'board.time': '시간',
      'board.all': '전체', 'board.week': '이번 주', 'board.month': '이번 달',
      'board.refresh': '새로고침', 'board.watch': '리플레이 보기', 'board.challenge': '도전',
      'board.anon': '누군가', 'board.topAt': '발행 당시 {rank}위', 'board.hold1': '1위 유지 {time}',
      'hof.title': '명예의 전당', 'hof.week': '주간', 'hof.month': '월간',
      'hof.empty': '아직 챔피언이 없습니다.', 'hof.this': '진행 중',
      'hof.wk': '{y}년 {w}주차', 'hof.mo': '{y}년 {mo}월',
      'hof.longest': '최장 1위 {time}', 'hof.longestNow': '최장 1위 {time} (진행 중)',
      'submit.title': '기록 제출', 'submit.name': '표시할 이름(선택)', 'submit.namePh': '비워 두면 자동 코드네임',
      'submit.reveal': '공유 링크에 내 이름을 표시', 'submit.nameWarn': '⚠ 공유 링크를 여는 사람은 재생 화면에서 이 이름을 본다. 링크를 다시 공유하면 그 사람에게도 보인다. 공개 보드·기간 집계·명예의 전당에는 이름이 실리지 않는다.', 'submit.go': '검증 요청', 'submit.offline': '오프라인 — 제출 불가',
      'submit.verifying': '서버가 리플레이를 다시 돌려보는 중…',
      'submit.queuedN': '검증 대기 {pos}번째 · 약 {sec}초',
      'submit.stillQueued': '아직 검증 대기 중입니다 — 결과가 나오면 공유 페이지에 표시됩니다',
      'submit.verified': '✓ 검증 완료 — 서버 재시뮬레이션으로 점수가 그대로 재현되었습니다',
      'submit.flagged': '⚑ 검증 통과 · 사람이 검수 표시함',
      'submit.soft': '관찰 지표만 기록됨(검수 대상 아님)',
      'submit.rejected': '✕ 거절됨', 'submit.duplicate': '이미 등록된 리플레이입니다',
      'submit.share': '공유 링크', 'submit.copy': '복사', 'submit.copied': '복사됨',
      'submit.rank': '{rank}위 / {total}개 기록 중', 'submit.newTop': '🏆 새 1위!',
      'submit.error': '제출 실패', 'submit.later': '나중에', 'submit.watch': '내 기록 보기',
      'replay.title': '리플레이', 'replay.speed': '배속', 'replay.challenge': '같은 조건으로 도전',
      'time.pair': '재현 {sim} · 클라이언트 {real} (차이 {delta})',
      'time.pairHint': '재현 = 서버가 같은 입력으로 다시 돌려본 시간(순위는 이쪽으로 매겨진다). 클라이언트 = 시드 발급→제출까지의 실측이라 화면을 보거나 대기한 시간이 들어 있다. 재현이 클라이언트보다 크면 물리적으로 성립하지 않으므로 서버가 기각한다.',
      'replay.by': '{who}의 기록', 'replay.exit': '닫기', 'replay.watch': '리플레이',
      'dev.phone': '폰', 'dev.tablet': '태블릿', 'dev.desktop': '데스크톱', 'dev.hybrid': '터치+키보드',
      'dev.hint': '기기는 브라우저가 스스로 보고한 분류입니다. 위조 가능하고 표시에만 쓰이며, 점수 판정에는 쓰지 않습니다.',
      'race.you': '나', 'race.them': '{who}', 'race.ahead': '+{gap}', 'race.behind': '-{gap}',
      'mine.title': '내 기록 (이 기기)', 'mine.empty': '이 브라우저에 저장된 기록이 없습니다.',
      'mine.clear': '목록 지우기',
      'mine.localOnly': '이 기기 기록 · 서버 미제출', 'mine.savedLocal': '오프라인 — 이 기기에만 기록으로 남겼습니다',
      'stats.players': '오늘 {n}명 · {m}개 네트워크',
      'lang.label': '언어',
      'err.network': '네트워크 오류', 'err.rate': '요청이 너무 많습니다. 잠시 후 시도하세요.',
      'err.banned': '이 네트워크는 차단되었습니다.',
    },
    en: {
      'ov.ready': 'Clear lines. Records are re-simulated by the server to be verified.',
      'ov.paused': 'Paused', 'ov.over': 'GAME OVER', 'ov.timeup': 'Time up', 'ov.finish': 'Goal reached!',
      'ov.newbest': '★ New best score!', 'ov.firstbest': 'First score registered!',
      'ov.retry': 'Give it another go?',
      'ui.start': 'START', 'ui.resume': 'RESUME', 'ui.retry': 'RETRY',
      'mode.marathon': 'Marathon', 'mode.sprint': 'Sprint 40L', 'mode.ultra': 'Ultra 2:00',
      'ultra.left': 'Time left',
      'label.SINGLE': 'SINGLE', 'label.DOUBLE': 'DOUBLE', 'label.TRIPLE': 'TRIPLE', 'label.TETRIS': 'TETRIS',
      'label.T-SPIN': 'T-SPIN', 'label.PERFECT CLEAR': 'PERFECT CLEAR', 'label.NEW RECORD': 'NEW RECORD',
      'board.title': 'WORLD RECORDS', 'board.me': 'My records', 'board.loading': 'loading…',
      'board.empty': 'No records yet. Be the first.',
      'board.rank': '#', 'board.player': 'Player', 'board.score': 'Score', 'board.time': 'Time',
      'board.all': 'All time', 'board.week': 'This week', 'board.month': 'This month',
      'board.refresh': 'refresh', 'board.watch': 'watch replay', 'board.challenge': 'challenge',
      'board.anon': 'someone', 'board.topAt': '#{rank} at submission', 'board.hold1': 'held #1 for {time}',
      'hof.title': 'HALL OF FAME', 'hof.week': 'Weekly', 'hof.month': 'Monthly',
      'hof.empty': 'No champions yet.', 'hof.this': 'in progress',
      'hof.wk': '{y} W{w}', 'hof.mo': '{mo}/{y}',
      'hof.longest': 'longest #1: {time}', 'hof.longestNow': 'longest #1: {time} (running)',
      'submit.title': 'Submit record', 'submit.name': 'Display name (optional)',
      'submit.namePh': 'blank = auto codename',
      'submit.reveal': 'Show my name on the share link', 'submit.nameWarn': '⚠ Anyone who opens the share link sees this name on the replay screen — including people it is re-shared with. Public boards, period boards and the Hall of Fame never carry names.', 'submit.go': 'Verify & submit',
      'submit.offline': 'offline — cannot submit',
      'submit.verifying': 'server is re-simulating your replay…',
      'submit.queuedN': '#{pos} in verification queue · ~{sec}s',
      'submit.stillQueued': 'still queued — the result will appear on the share page',
      'submit.verified': '✓ verified — the server reproduced your score exactly',
      'submit.flagged': '⚑ verified · marked for review by a human',
      'submit.soft': 'observation flags only (not queued for review)',
      'submit.rejected': '✕ rejected', 'submit.duplicate': 'this replay is already registered',
      'submit.share': 'Share link', 'submit.copy': 'copy', 'submit.copied': 'copied',
      'submit.rank': '#{rank} of {total}', 'submit.newTop': '🏆 New #1!',
      'submit.error': 'submit failed', 'submit.later': 'later', 'submit.watch': 'watch it',
      'replay.title': 'REPLAY', 'replay.speed': 'speed', 'replay.challenge': 'challenge on this map',
      'time.pair': 'simulated {sim} · client {real} (diff {delta})',
      'time.pairHint': 'Simulated = the time the server got by replaying the same inputs (this is what ranking uses). Client = measured from seed issue to submit, so it includes time spent looking at the screen. Simulated larger than client cannot physically happen — the server rejects it.',
      'replay.by': "{who}'s record", 'replay.exit': 'close', 'replay.watch': 'replay',
      'dev.phone': 'phone', 'dev.tablet': 'tablet', 'dev.desktop': 'desktop', 'dev.hybrid': 'touch+keyboard',
      'dev.hint': 'The device class is self-reported by the browser: it can be faked, is display-only, and is never used to judge a score.',
      'race.you': 'you', 'race.them': '{who}', 'race.ahead': '+{gap}', 'race.behind': '-{gap}',
      'mine.title': 'My records (this device)', 'mine.empty': 'No records saved in this browser.',
      'mine.clear': 'clear list',
      'mine.localOnly': 'on this device · not submitted', 'mine.savedLocal': 'Offline — saved on this device only',
      'stats.players': '{n} players · {m} networks today',
      'lang.label': 'language',
      'err.network': 'network error', 'err.rate': 'too many requests, try later',
      'err.banned': 'this network is blocked',
    },
    ja: {
      'ov.ready': 'ラインを消してスコアを積もう。記録はサーバーが同じように入力して検証します。',
      'ov.paused': '一時停止', 'ov.over': 'ゲームオーバー', 'ov.timeup': '時間切れ', 'ov.finish': '目標達成！',
      'ov.newbest': '★ 最高スコア更新！', 'ov.firstbest': '初のスコア登録！', 'ov.retry': 'もう一度挑戦？',
      'ui.start': 'スタート', 'ui.resume': '再開', 'ui.retry': 'リトライ',
      'mode.marathon': 'マラソン', 'mode.sprint': 'スプリント40L', 'mode.ultra': 'ウルトラ2分',
      'ultra.left': '残り時間',
      'label.SINGLE': 'シングル', 'label.DOUBLE': 'ダブル', 'label.TRIPLE': 'トリプル', 'label.TETRIS': 'テトリス',
      'label.T-SPIN': 'Tスピン', 'label.PERFECT CLEAR': 'パーフェクトクリア', 'label.NEW RECORD': '新記録',
      'board.title': 'ワールド記録', 'board.me': '自分の記録', 'board.loading': '読み込み中…',
      'board.empty': 'まだ記録がありません。',
      'board.rank': '順位', 'board.player': 'プレイヤー', 'board.score': 'スコア', 'board.time': '時間',
      'board.all': '総合', 'board.week': '今週', 'board.month': '今月',
      'board.refresh': '更新', 'board.watch': 'リプレイ', 'board.challenge': '挑戦',
      'board.anon': 'だれか', 'board.topAt': '提出当時 {rank}位', 'board.hold1': '1位維持 {time}',
      'hof.title': '殿堂', 'hof.week': '週間', 'hof.month': '月間',
      'hof.empty': 'まだチャンピオンがいません。', 'hof.this': '進行中',
      'hof.wk': '{y}年{w}週', 'hof.mo': '{y}年{mo}月',
      'hof.longest': '最長1位 {time}', 'hof.longestNow': '最長1位 {time} (進行中)',
      'submit.title': '記録提出', 'submit.name': '表示名（任意）', 'submit.namePh': '空欄なら自動コードネーム',
      'submit.reveal': '共有リンクに名前を表示', 'submit.nameWarn': '⚠ リンクを開いた人は再生画面でこの名前を見ます。再共有した先にも見えます。公開ボード・期間集計・殿堂に名前は出ません。', 'submit.go': '検証して提出', 'submit.offline': 'オフライン — 提出不可',
      'submit.verifying': 'サーバーがリプレイを再生成中…',
      'submit.queuedN': '検証待機 {pos}番目 · 約{sec}秒',
      'submit.stillQueued': 'まだ待機中です — 結果は共有ページに表示されます',
      'submit.verified': '✓ 検証完了 — スコアが完全に再現されました',
      'submit.soft': '観測指標のみ記録（レビュー対象外）',
      'submit.flagged': '⚑ 検証通過 · 人手でレビュー指定', 'submit.rejected': '✕ 却下',
      'submit.duplicate': 'このリプレイは登録済みです',
      'submit.share': '共有リンク', 'submit.copy': 'コピー', 'submit.copied': 'コピーしました',
      'submit.rank': '{rank}位 / {total}件中', 'submit.newTop': '🏆 新1位！',
      'submit.error': '提出失敗', 'submit.later': 'あとで', 'submit.watch': 'リプレイを見る',
      'replay.title': 'リプレイ', 'replay.speed': '速度', 'replay.challenge': '同じ条件で挑戦',
      'time.pair': '再現 {sim} · クライアント {real} (差 {delta})',
      'time.pairHint': '再現 = サーバーが同じ入力で遊び直した時間（順位はこれで決まる）。クライアント = シード発行から送信までの実測で、画面を見て待った時間も含む。再現の方がクライアントより大きければ物理的に成立しないのでサーバーが却下する。',
      'replay.by': '{who} の記録', 'replay.exit': '閉じる', 'replay.watch': 'リプレイ',
      'dev.phone': 'フォン', 'dev.tablet': 'タブレット', 'dev.desktop': 'デスクトップ', 'dev.hybrid': 'タッチ+キーボード',
      'dev.hint': '機器分類はブラウザが自分で申告したものです。偽装可能で表示専用、採点には使いません。',
      'race.you': '自分', 'race.them': '{who}', 'race.ahead': '+{gap}', 'race.behind': '-{gap}',
      'mine.title': '自分の記録（この端末）', 'mine.empty': 'このブラウザに保存された記録はありません。',
      'mine.clear': '一覧を消す',
      'mine.localOnly': 'この端末のみ · 未提出', 'mine.savedLocal': 'オフライン — この端末にのみ保存しました',
      'stats.players': '本日 {n}人 · {m}ネットワーク',
      'lang.label': '言語',
      'err.network': 'ネットワークエラー', 'err.rate': 'リクエストが多すぎます', 'err.banned': 'この回線はブロックされています',
    },
    zh: {
      'ov.ready': '消行得分。记录会由服务器重新模拟来验证。',
      'ov.paused': '暂停中', 'ov.over': '游戏结束', 'ov.timeup': '时间到', 'ov.finish': '达成目标！',
      'ov.newbest': '★ 新纪录！', 'ov.firstbest': '首次记录！', 'ov.retry': '再来一次？',
      'ui.start': '开始', 'ui.resume': '继续', 'ui.retry': '重试',
      'mode.marathon': '马拉松', 'mode.sprint': '冲刺40行', 'mode.ultra': '限时2分',
      'ultra.left': '剩余时间',
      'label.SINGLE': 'Single', 'label.DOUBLE': 'Double', 'label.TRIPLE': 'Triple', 'label.TETRIS': 'Tetris',
      'label.T-SPIN': 'T-Spin', 'label.PERFECT CLEAR': '全消', 'label.NEW RECORD': '新纪录',
      'board.title': '世界纪录', 'board.me': '我的记录', 'board.loading': '加载中…',
      'board.empty': '还没有记录。',
      'board.rank': '排名', 'board.player': '玩家', 'board.score': '分数', 'board.time': '时间',
      'board.all': '总榜', 'board.week': '本周', 'board.month': '本月',
      'board.refresh': '刷新', 'board.watch': '看回放', 'board.challenge': '挑战',
      'board.anon': '某人', 'board.topAt': '提交时第 {rank} 名', 'board.hold1': '第一名保持 {time}',
      'hof.title': '名人堂', 'hof.week': '周榜', 'hof.month': '月榜',
      'hof.empty': '尚无冠军。', 'hof.this': '进行中',
      'hof.wk': '{y} 第{w}周', 'hof.mo': '{y}年{mo}月',
      'hof.longest': '最长第一 {time}', 'hof.longestNow': '最长第一 {time}（进行中）',
      'submit.title': '提交记录', 'submit.name': '显示名（可选）', 'submit.namePh': '留空则用自动代号',
      'submit.reveal': '分享链接中显示我的名字', 'submit.nameWarn': '⚠ 打开分享链接的人会在回放画面看到这个名字——被再次分享后也一样可见。公开榜、期间榜、名人堂都不会带名字。', 'submit.go': '验证并提交', 'submit.offline': '离线 — 无法提交',
      'submit.verifying': '服务器正在重新模拟…',
      'submit.queuedN': '验证排队第 {pos} 位 · 约 {sec} 秒',
      'submit.stillQueued': '仍在排队 — 结果会显示在分享页',
      'submit.verified': '✓ 已验证 — 分数被完全复现',
      'submit.soft': '仅记录观察指标（不进入审查）',
      'submit.flagged': '⚑ 已验证 · 已由人工标记审查', 'submit.rejected': '✕ 被拒绝',
      'submit.duplicate': '该回放已登记',
      'submit.share': '分享链接', 'submit.copy': '复制', 'submit.copied': '已复制',
      'submit.rank': '第 {rank} 名 / 共 {total}', 'submit.newTop': '🏆 新第一！',
      'submit.error': '提交失败', 'submit.later': '稍后', 'submit.watch': '看回放',
      'replay.title': '回放', 'replay.speed': '速度', 'replay.challenge': '同条件挑战',
      'time.pair': '重放 {sim} · 客户端 {real}（差 {delta}）',
      'time.pairHint': '重放 = 服务器用同样的输入重新跑出的时间（排名用这个）。客户端 = 从发放种子到提交的实测，包含看屏幕的等待时间。重放比客户端还大就物理上不成立，服务器会拒绝。',
      'replay.by': '{who} 的记录', 'replay.exit': '关闭', 'replay.watch': '回放',
      'dev.phone': '手机', 'dev.tablet': '平板', 'dev.desktop': '台式机', 'dev.hybrid': '触屏+键盘',
      'dev.hint': '设备分类由浏览器自行上报（可伪造，仅作展示）——不用于判定成绩。',
      'race.you': '我', 'race.them': '{who}', 'race.ahead': '+{gap}', 'race.behind': '-{gap}',
      'mine.title': '我的记录（本设备）', 'mine.empty': '此浏览器没有保存的记录。',
      'mine.clear': '清空列表',
      'mine.localOnly': '仅本机 · 未提交', 'mine.savedLocal': '离线 — 仅保存在本机',
      'stats.players': '今日 {n} 人 · {m} 个网络',
      'lang.label': '语言',
      'err.network': '网络错误', 'err.rate': '请求过多', 'err.banned': '该网络被封禁',
    },
  };

  const LANGS = ['ko', 'en', 'ja', 'zh'];
  let lang = 'ko';

  function detect(explicit) {
    const pool = [].concat(explicit || [], (navigator.languages || []), navigator.language || 'ko');
    for (const p of pool) {
      const two = String(p).toLowerCase().slice(0, 2);
      if (LANGS.indexOf(two) >= 0) return two;
    }
    return 'ko';
  }

  function set(l) {
    lang = CATALOG[l] ? l : 'ko';
    try { localStorage.setItem('neon-tetris-lang', lang); } catch (e) { }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
      document.body.dataset.lang = lang;
    }
    return lang;
  }
  function get() { return lang; }

  function t(key, vars) {
    let s = (CATALOG[lang] && CATALOG[lang][key]) || CATALOG.ko[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }

  /** 엔진이 내는 라벨(TETRIS / T-SPIN MINI DOUBLE / COMBO x3 / LEVEL 5) → 표어 */
  function label(text) {
    if (!text) return text;
    const m = /^COMBO x(\d+)$/i.exec(text);
    if (m) return lang === 'ko' ? '연속 x' + m[1] : text;
    const l = /^LEVEL (\d+)$/i.exec(text);
    if (l) return lang === 'ko' ? '레벨 ' + l[1] : text;
    if (text === 'T-SPIN MINI') return lang === 'ko' ? 'T-스핀 미니' : lang === 'ja' ? 'TスピンMINI' : text;
    if (text.indexOf('T-SPIN') === 0) {
      const rest = text.slice(6);
      const tail = rest ? ' ' + t('label.' + rest.trim()) : '';
      return (lang === 'ko' ? 'T-스핀' : lang === 'ja' ? 'Tスピン' : 'T-SPIN') + tail;
    }
    return t('label.' + text) !== 'label.' + text ? t('label.' + text) : text;
  }

  /** 언어별 타이포그래피: 한국어는 word-break: keep-all 이 기본 (CJK 기본값이 문장을 중간에 자름) */
  function css() {
    return lang === 'ko' ? 'keep-all' : lang === 'ja' || lang === 'zh' ? 'normal' : 'normal';
  }

  return {
    LANGS: LANGS, detect: detect, set: set, get: get, t: t, label: label, catalog: CATALOG, css: css,
  };
});
