# 배포

먼저 **[QUICKSTART.md](QUICKSTART.md)** (혼자 하기 / 서버 한 대 / 공개 배포의 세 갈래). 이 문서는 그 **세부**다 — 실물 설정과 운영 이야기만 담는다.

- §1 로컬/테스트 · §2 환경변수 · §3 systemd · §4 리버스 프록시(HTTPS) · §5 Docker
- §6 SQLite 운영/백업 · §6.5 큐 모니터링 · §6.9 규칙 버전을 올리며 배포
- §7 검수 · §8 배포 전 체크리스트

## 0. 소스 / 저장소

브랜치는 `main` 하나다. remote 는 두 개다 — **공개 저장소**와, 그걸 잃어버려도 되는 **로컬 백업**:

```bash
git remote -v
#   github  https://github.com/akamotaco/q__tetris.git   ← 업스트림 (여기로 push 된다)
#   origin  C:/Users/akamo/repos/neon-tetris.git         ← 로컬 베어 저장소 (백업, OneDrive 밖)

git push                     # = git push github main
git push origin main         # 백업까지 (커밋마다 같이 돌린다)
git tag -a v1.2 -m '...' && git push --tags && git push origin --tags
```

로컬 베어 저장소를 써 둔 이유는 "서버 없이도 push 가능한 remote" 를 가지려는 것이다(실수로 브랜치를 날려도
되돌릴 곳). 한쪽이 망해도 다른 쪽이 같은 커밋을 가지고 있다.

호스팅 서버에는 공개 저장소를 클론하거나, 파일만 올려도 된다(빌드 없음):

```bash
git clone https://github.com/akamotaco/q__tetris.git /srv/neon-tetris   # 최초 배포
cd /srv/neon-tetris && git pull --ff-only && sudo systemctl restart neon-tetris   # 업그레이드
sudo systemctl stop neon-tetris && cp -a data data.bak-$(date +%F) && sudo systemctl start neon-tetris   # 롤백 전 백업
```

> **올리기 전 확인**: `data/`(DB·시크릿) 은 `.gitignore` 로 잡혀 있어 커밋되지 않는다. 그래도 공개 저장소에
> 올리기 전엔 `git log --all --name-only | grep -E "^data/|secret"` 이 빗난 적은 없는지 한 번 봐 두는 게 싸다.

## 1. 로컬/테스트

**의존성 설치 없음** — `npm install` 할 것이 없다. Node 하나면 된다.

```bash
node --version    # 23.4 이상 권장(24 LTS 무난). node:sqlite 가 플래그 없이 열리기 시작한다
node server/server.js                     # http://localhost:8787, DB: ./data/tetris.db
PORT=80 NT_SECRET=... node server/server.js
```

Windows 에서는 위 마지막 줄을 그대로 칠 수 없다(`VAR=값 명령` 은 POSIX 셸 문법이고 `openssl` 도 없다). PowerShell 버전:

```powershell
$env:PORT = '80'
$env:NT_SECRET = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node server\server.js
```

(cmd 를 쓴다면 `set PORT=80` 을 별도 줄로 실행한 뒤 같은 프로세스에서 기동해야 한다 — 그래서 이 문서의 Windows 예제는 PowerShell 로 적었다.)

**Node 22.5 – 23.3 을 써야 한다면 플래그를 붙여라** — 안 붙히면 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` 로 죽는다(지금의 `server/db.js` 는 그 상황에서 읽을 수 있는 안내를 띄운다):

```bash
node --experimental-sqlite server/server.js
```

systemd 를 쓰면 `ExecStart=/usr/bin/node --experimental-sqlite server/server.js` 로. Docker 이미지는 `node:24-slim` 이라 필요 없다.
`package.json` 의 `engines` 는 최솟값만 걸어 두었다 — 실제로는 24 LTS 를 권한다.

## 2. 환경변수

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `PORT` / `NT_PORT` | `8787` | 리스닝 포트 |
| `NT_HOST` | `0.0.0.0` | 바인드 주소 |
| `NT_SECRET` | 없으면 `data/secret` 에 생성 | 시드 서명·IP 해시 키. **분실 시 발급 대기 중이던 시드가 무효화되고 IP 해시 기준이 바뀐다** — 고정해서 백업할 것 |
| `NT_DATA` | `./data` | SQLite(`tetris.db`)·시크릿 저장 경로 |
| `NT_BASE_URL` | 요청 Host 로 추론 | 공유 링크 절대 URL(OG) 생성 |
| `NT_TRUST_HOPS` | `1` | 신뢰하는 프록시 hop 수. 리버스 프록시 뒤가 아니면 `0` (아니면 XFF 위조로 레이트리밋·IP 힌트 조작 가능) |
| `NT_WORKERS` | 코어-1, 최대 4 | 재시뮬 워커 수. 1코어 VPS 면 `1` |
| `NT_QUEUE_CAP` | `400` | 검증 대기열 상한. 초과 시 503 + `Retry-After: 60` |
| `NT_INFLIGHT_IP` | `2` | 한 네트워크(IP 해시)의 동시 대기 제출 수. 초과 시 429 |
| `NT_PROMOTE_MS` | `90000` | 이만큼 기다린 검증 건은 티어와 무관하게 앞으로(기아 방지) |
| `NT_TEST_MODE` | ✕ | **운영 금지.** 월클럭 검사·레이트리밋을 완화한다 |

정적 파일은 **허용 목록**(`server/server.js:STATIC`)만 제공한다. 새 에셋을 추가하면 목록에도 넣어라 — 목록에 없는 것은 404라 `server/`, `data/`, `tools/` 노출 사고가 구조적으로 불가능하다.

## 3. systemd

```ini
# /etc/systemd/system/neon-tetris.service
[Unit]
Description=NEON TETRIS
After=network.target

[Service]
Type=simple
User=tetris
WorkingDirectory=/srv/neon-tetris
Environment=PORT=8787 NT_TRUST_HOPS=1 NT_BASE_URL=https://tetris.example.com
EnvironmentFile=/etc/neon-tetris/secret.env      # NT_SECRET=... (chmod 600)
ExecStart=/usr/bin/node server/server.js
Restart=always
RestartSec=2
# 최소 권한
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/neon-tetris/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now neon-tetris
journalctl -u neon-tetris -f
```

## 4. 리버스 프록시 (HTTPS 필수)

**HTTPS가 없으면 브라우저가 WebCrypto를 쓰지 못한다**(secure context). 즉 서명·제출·공유가 꺼지고 게임만 플레이 가능 mode가 된다.

```nginx
server {
  listen 443 ssl http2;
  server_name tetris.example.com;
  # ssl_certificate ...;
  client_max_body_size 1m;              # 제출 본문 상한 512KB + 여유
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Caddy는 `reverse_proxy 127.0.0.1:8787` 한 줄이면 XFF/HTTPS 자동.

## 5. Docker

```bash
docker build -t neon-tetris .
docker run -d -p 8787:8787 -v $PWD/data:/app/data --env-file secret.env --restart unless-stopped neon-tetris
```

## 6. SQLite 운영

- WAL 모드(`data/tetris.db-wal`이 생긴다). 같은 폴더를 **로컬 디스크**에 두라(NFS는 WAL에 위험).
- 백업(핫카피): `sqlite3 data/tetris.db ".backup 'backup/tetris-$(date +%F).db'"` 를 cron으로. 순수 카피라면 `wal_checkpoint(TRUNCATE)` 후 복사.
- 여러 노드로 띄우면 SQLite는 쓰기 경합이 생긴다(재시뮬 병렬도는 괜찮아도 등록은 직렬). 스케일 아웃이 필요해지면 **LiteFS**(Fly)나 Postgres로 옮긴다. 그때도 `engine.js`/`verify.js`는 그대로 쓴다.
- 파기 작업(IP 해시·레이트 테이블)은 서버가 10분/1시간 주기로 자동으로 돌린다. 기록 자체는 삭제하지 않는다.

## 6.5 큐 모니터링

`GET /api/queue` 와 `GET /api/health` 가 큐 상태를 돌려준다:

```json
{ "workers": 2, "busy": 0, "depth": {"t0":0,"t1":0,"t2":0}, "waiting": 0,
  "done": 200, "rejected": 0, "failed": 0,
  "simAvgMs": 8.3, "simMaxMs": 26, "waitAvgMs": 874, "waitMsMax": 1647, "depthMax": 192,
  "loopLag": {"n":556,"p50":11.7,"p95":12.4,"max":448.5} }
```

- `waiting` 이 계속 커진다 → 워커를 늘리거나(코어 여유 확인) `NT_QUEUE_CAP` 로 폭주를 깎는다.
- `loopLag.p95` 가 커진다 → **메인 스레드가 막히고 있다는 뜻**(규칙상 검증은 워커에서 도므로, 대개 디스크/네트워크/대용량 요청 쪽 문제다).
- `failed` 는 워커 크래시 재시도 소진. 0 이 정상이다.
- 스케일 아웃: 워커는 프로세스 안의 CPU 풀이다. 여러 인스턴스로 늘리면 인스턴스마다 자기 큐를 돌린다(SQLite 쓰기가 직렬이므로 동시 발행이 경합한다 — 라이트웨이는 LiteFS 또는 Postgres 로).

## 6.9 규칙 버전(`RULES_ID`)을 올리며 배포하기

엔진의 규칙(점수표·SRS 킥·T-스핀 판정·락 딜레이·장식과 판정이 엮인 모든 것)을 바꾸면 `engine.js` 의 `RULES_ID` 를 올린다.
그러면 배포 후에 이런 일이 일어난다 — 전부 **의도된 동작**이고, 고른 적 없는 데이터는 조용히 사라지지 않는다:

| 대상 | 새 버전 배포 후 |
| --- | --- |
| 이미 검증된 순위 행 | 그대로 보드에 남는다 (append-only. 점수를 사후 재계산하지 않는다) |
| 과거 규칙의 리플레이 **재제출** | 재시뮬 전에 `rules-version:<old>!=<new>` 으로 기각 (CPU를 태우지 않음) |
| 과거 규칙의 `/r/<share>` 페이지 | 열린다. 다만 재생은 **현재 엔진으로** 재시뮬하므로 조각이 놓이는 위치가 달라 보일 수 있다 |
| 진행 중이던 시드 토큰 | 배포로 재기동하면 만료된다(사용자는 그냥 새로 시작) |

지킬 것 두 개:

1. **올리기 전에 DB 백업** — `cp -a data data.bak-$(date +%F)`. 되돌릴 수 없는 방향으로 데이터가 쌓이기 시작한다.
2. `tools/probe.js` 의 `RULES_EXPECT` 와 README 규칙 표를 **함께** 올린다. 테스트가 일부러 깨지게 해 두었다 — 버전 번호를 무시하고 넘어가지 못하게.

과거 리플레이를 앞으로도 재생/검증할 계획이라면, 그 버전 엔진 스냅샷을 따로 보관해야 한다(예: `legacy/r1/engine.js`).
아직은 하지 않는다 — 공개된 리플레이가 없는 지금이 규칙을 고칠 수 있는 가장 싼 순간이기 때문이다.

## 7. 운영/검수
```bash
node tools/review.js                 # 플래그 대기열(지표·네트워크·지문·순위 이력)
node tools/review.js --show <share>  # 상세
node tools/review.js --clear <share> # 문제없음 → verified
node tools/review.js --hide <share>  # 목록 제외 → hidden (데이터는 남음)
```

- 차단 해제: `node -e "require('./server/db').db.prepare('DELETE FROM bans WHERE k=?').run(process.argv[1])" <ip_hash>`
- 수동 차단: `db.ban(DB.ipToHash('1.2.3.4'), 'reason')`

## 8. 배포 전 체크리스트

- [ ] `NT_SECRET` 고정·백업 (`data/secret` 만으로도 충분하니 함께 백업)
- [ ] HTTPS + `NT_BASE_URL` 설정 → `/r/<share>` 의 OG 미리보기가 카톡/디코드에 뜨는지 확인
- [ ] `NT_TRUST_HOPS`가 실제 프록시 구조와 일치 (프록시 없으면 0)
- [ ] `data/` 가 로컬 디스크 + 백업 cron
- [ ] 규칙을 바꿨다면 `RULES_ID` · `tools/probe.js:RULES_EXPECT` · README 규칙 표 셋 다 올렸는가
- [ ] `npm test && npm run test:browser` 통과
- [ ] `npm run load` 로 폭주 시뮬레이션: `waiting` 이 쌓여도 `loopLag.p95` 가 조용한지
- [ ] **[UNVERIFIED.md](UNVERIFIED.md)** 에서 배포에 막히는 항목을 소화했는가 — 특히 #1(이 문서의 설정을 글자대로 실기동) 과 #2(공유 IP 한도)
- [ ] `NT_TEST_MODE` 미설정 확인
- [ ] `GET /api/health`, `GET /api/board?mode=marathon` 응답 확인
