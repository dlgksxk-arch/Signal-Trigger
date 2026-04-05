# Longform 자동 공장

`lapin.ai.kr/products/longform` 페이지에서 확인한 핵심 흐름을 기준으로 만든 로컬 실행형 MVP입니다.

지원 범위:
- 주제 입력
- 트렌드 리서치
- 대본 생성
- 장면 분할
- 스타일 레퍼런스 추출
- 이미지 생성
- TTS 음성 생성
- 자막(SRT) 생성
- FFmpeg 렌더링
- 썸네일 생성
- 장면별 재생성
- 워터마크 / BGM
- 채널별 예약 업로드용 웹훅 호출
- 다중 채널 관리
- 내장 도움말 챗봇

실행:

```bash
npm install
npm run start
```

브라우저:

```text
http://127.0.0.1:3100
```

서버를 띄운 PowerShell 창은 닫지 않아야 합니다.

## 버전 규칙

- 버전 형식: `major.minor.patch`
- 화면 표기 형식: `V0.0.2`
- 변경할 때마다 버전을 올리고 루트 `CHANGELOG.md`에 기록합니다.
- GitHub 원격 저장소가 연결되어 있으면 버전업 후 푸시합니다.

## 외부 연동

- `OPENAI_API_KEY`가 있으면 더 자연스러운 대본이 생성됩니다.
- 키가 없으면 템플릿 기반 대본으로 동작합니다.
- 이미지 생성은 기본적으로 `Pollinations` 무료 엔드포인트를 먼저 시도하고, 실패하면 자동으로 플레이스홀더 이미지를 만듭니다.
- 유튜브 직접 업로드는 채널의 `업로드 웹훅 URL`에 `n8n` 웹훅 주소를 넣는 방식으로 연결합니다.

## n8n

```bash
docker compose up -d
```

`n8n` 주소:

```text
http://localhost:5678
```

예시 워크플로우 파일:
- `n8n/longform-webhook-upload.json`

이 워크플로우는 앱이 예약 시점에 보내는 업로드 페이로드를 받아 후속 자동화를 붙일 수 있게 만든 시작점입니다.
