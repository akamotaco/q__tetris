# 배포

의존성 설치 없음(`npm install` 할 것이 없다). Node만 있으면 된다.

```bash
node --version    # v22.5 이상 — node:sqlite 가 이부터 내장
```

## 1. 로컬/테스트

```bash
node server/server.js                     # http://localhost:8787, DB: ./data/tetris.db
PORT=80 NT_SECRET=... node server/server.js
```

## 2. 환경변수

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `PORT` / `NT_PORT` | `8787` | 리스닝 포트 |
| `NT_HOST` | `0.0.0.0` | 바인드 주소 |
| `NT_SECRET` | 없으면 `data/secret` 에 생성 | 시드 서명·IP 해시 키. **분실 시 발급 대기 중이던 시드가 무효화되고 IP 해시 기준이 바뀐다** — 고정해서 백업할 것 |
| `NT_DATA` | `./data` | SQLite(`tetris.db`)·시크릿 저장 경로 |
| `NT_BASE_URL` | 요청 Host 로 추론 | 공유 링크 절대 URL(OG) 생성 |
| `NT_TRUST_HOPS` | `1` | 신뢰하는 프록시 hop 수. 리버스 프록시 뒤가 아니면 `0` (아니면 XFF 위조로 레이트리밋·IP 힌트 조작 가능) |
| `NT_SIM_SLOTS` | `3` | 동시에 재시뮬할 요청 수(CPU 보호). 초과 시 503 + `Retry-After` |
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
- [ ] `npm test && npm run test:browser` 통과
- [ ] `NT_TEST_MODE` 미설정 확인
- [ ] `GET /api/health`, `GET /api/board?mode=marathon` 응답 확인
