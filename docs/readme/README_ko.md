<div align="center">

<img src="../../app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](../../README.md)　·　[繁體中文](./README_zh-TW.md)　·　[English](./README_en.md)　·　[日本語](./README_ja.md)　·　한국어　·　[Español](./README_es.md)　·　[Français](./README_fr.md)　·　[Русский](./README_ru.md)
<!-- lang-nav -->

**Windows용 음성 합성 및 캐릭터 음성 학습 소프트웨어**

[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)를 기반으로 개발되었으며 [Turing Mirror](https://github.com/Turing-Mirror)가 유지보수합니다.

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](../../app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[GitHub 저장소](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [CNB 아티팩트 다운로드](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**소셜 미디어**　[Bilibili @Turing Mirror](https://space.bilibili.com/3546871148579062)　·　[Douyin @Turing Mirror](https://v.douyin.com/6NxXcrKK9cc) (Douyin ID `TuringMirror`)　·　[Xiaohongshu @Turing Mirror](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094) (Xiaohongshu ID `TuringMirror`)　·　[YouTube @Turing Mirror](https://www.youtube.com/@TuringMirror) (YouTube 핸들 `@TuringMirror`)　·　QQ 그룹 @Turing Mirror 커뮤니티 (그룹 번호 `1077458748`)

<img src="../../app/src/assets/qq_group.jpg" alt="QQ 그룹 QR 코드" width="200">

</div>

---

## 스크린샷

![홈 화면](../screenshots/home.png)

![음성 합성](../screenshots/synthesis.png)

## 프로젝트 소개

GPT-SoVITS Fabric은 Turing Mirror가 GPT-SoVITS를 기반으로 개발한 무료 오픈 소스 Windows 데스크톱 소프트웨어입니다. 텍스트 음성 합성, 캐릭터 음성 관리, `.list` 주석 편집, 보컬 분리, 모델 학습을 하나의 독립 실행형 클라이언트에 통합했습니다. 사용자가 직접 Python 환경을 구성하거나 브라우저 WebUI를 실행할 필요 없이, 설치 후 안내에 따라 실행 환경과 기본 모델을 내려받아 바로 사용할 수 있습니다.

## 핵심 기능

- **음성 합성**: 단일 및 일괄 텍스트 합성을 지원하며, 캐릭터에 연결된 `.list` 주석에서 3~10초 길이의 참조 오디오를 선택할 수 있습니다. 보조 참조 혼합, 스트리밍 출력, 캐릭터별 파라미터 프리셋 저장, WAV 및 FLAC 내보내기를 지원합니다.
- **추론 엔진**: 기본값으로 내장 Python 실행 환경을 통해 CUDA 또는 CPU에서 추론하며 `v1`, `v2`, `v2Pro`, `v2ProPlus`, `v3`, `v4`, `v5dev`, `v5turbo` 캐릭터를 지원합니다. 필요에 따라 Vulkan 리소스를 내려받아 Windows에서 [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp)를 통해 `v5turbo` 중국어 및 일본어 합성을 실행할 수도 있습니다.
- **캐릭터 라이브러리 관리**: SoVITS 가중치, GPT 가중치, 참조 오디오, `.list` 주석, 커버 이미지, 권장 파라미터를 캐릭터 패키지로 관리합니다. 가져오기, 일괄 내보내기, 정보 편집, 커버 자르기, 가중치 교체를 지원합니다.
- **주석 및 데이터 준비**: 내장 `.list` 주석 편집기에서 저장 전에 누락된 오디오, 빈 텍스트, 중복 항목, 언어 태그를 검사합니다. 학습 데이터와 합성 참조 정리를 위한 보컬 분리, 오디오 분할, 자동 전사 도구를 제공합니다.
- **모델 학습**: 데이터 준비부터 SoVITS 및 GPT 미세 조정까지의 전체 흐름을 제공합니다. `v2`, `v2Pro`, `v2ProPlus`, `v4`, `v5dev`, `v5turbo` 버전 학습을 지원하며 순차 학습 대기열과 중단 후 재개를 지원합니다.
- **커뮤니티 및 리소스 다운로드**: 커뮤니티 화면에서 공개 캐릭터 팩, 엔진 기본 리소스, 버전별 기반 모델, 보컬 분리 모델을 찾아 다중 연결 및 이어받기로 다운로드할 수 있습니다. Turing Mirror 계정에 로그인하면 캐릭터 게시물을 제출하고 업데이트할 수 있습니다.
- **로컬 API 및 MCP**: 독립 백그라운드 서비스와 `gpt-sovits-fabric-mcp.exe`가 함께 제공되어 로컬 프로그램이나 MCP 클라이언트가 캐릭터 목록을 조회하고 음성 합성 작업을 실행할 수 있습니다. 자세한 내용은 [API v1](../api-v1.md)을 참조하십시오.

## 빠른 시작

1. GPT-SoVITS Fabric을 설치한 뒤 첫 실행 안내에 따라 실행 환경(NVIDIA GPU는 CUDA 버전, 그 외에는 CPU 버전)과 엔진 기본 리소스를 다운로드합니다.
2. 「커뮤니티」에서 공개 캐릭터 팩을 내려받거나 「모델」 화면에서 로컬 캐릭터 팩을 가져옵니다. 직접 음성을 만들려면 「학습」 화면에서 데이터를 준비하고 미세 조정을 진행합니다.
3. 「합성」을 열어 캐릭터와 3~10초 참조 오디오를 선택하고 텍스트를 입력한 뒤 추론 엔진을 골라 합성을 시작합니다.
4. 외부 프로그램이나 MCP 클라이언트와 연동하려면 [API v1](../api-v1.md)을 참고해 `gpt-sovits-fabric-mcp.exe`를 구성하거나 `--headless`로 백그라운드 서비스를 실행하십시오.

## 기술 아키텍처 및 개발

### 아키텍처

GPT-SoVITS Fabric은 **Tauri + Rust + React** 데스크톱 셸을 사용하며, 추론과 학습 연산은 백그라운드 프로세스가 처리합니다. CUDA 추론, 모델 학습, 보컬 분리는 내장 Python Worker를 통해 실행되고 Vulkan 합성은 로컬 `gsv.cpp` 서버로 실행됩니다. 데스크톱 UI와 로컬 API는 동일한 작업 흐름과 출력 기록을 공유합니다:

```text
GPT-SoVITS Fabric.exe (Tauri + Rust + React 데스크톱 앱 및 로컬 API)
    ├─ CUDA / 학습 / 분리 ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Vulkan 합성        ─> gsv_server.exe (gsv.cpp, v5turbo 지원)
```

업스트림 Gradio WebUI(`webui.py`)는 패키지에 함께 포함되어 있으며 필요할 때 「기타」 화면에서 열 수 있습니다.

### 환경 요구 사항 및 개발

**환경 요구 사항**: Windows 10/11 · Node.js 20+ · Rust Stable(`x86_64-pc-windows-msvc`) · Visual Studio C++ 빌드 도구 및 WebView2 · Python 3.12+(빌드 스크립트)

```powershell
# 1. 프론트엔드 의존성 설치 및 페이지 빌드
cd app
npm ci
npm run build

# 2. 개발용 제품 루트 조립 및 데스크톱 앱 실행 (Visual Studio Developer PowerShell에서 실행)
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

브라우저에서 UI만 미리 보려면 `app/`에서 `npm run dev`를 실행하십시오. 자세한 빌드 절차, 의존성 빌드 문제 해결, 설계 결정은 [Windows 개발 v1](../development-v1.md)과 [설계 결정 기록](../DECISIONS.md)을 참조하십시오.

### 빌드 및 테스트

- **프론트엔드 단위 테스트 및 검사**: `cd app && npm test`, `npm run build`
- **Rust 단위 테스트**: `cd app/src-tauri && cargo test --locked --lib`
- **설치 프로그램 패키징(NSIS)**: `python scripts/build_setup.py` (또는 `cd app && npm run tauri:build`)
- **업스트림 소스 동기화**: `python scripts/prepare_engine_payload.py --upstream <업스트림 저장소> --runtime <Runtime>`
- **Runtime 빌드**: `python scripts/build_runtime.py --variant nvidia` (또는 `cpu`)
- **기반 모델 팩 빌드**: `python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **온라인 카탈로그 빌드**: `python scripts/build_catalog.py --sources <릴리스 저장소>/catalog/sources.json --out <릴리스 저장소>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## 라이선스 및 음성 사용 허가

- 본 프로젝트의 소스 코드는 [MIT License](../../app/src-tauri/engine-payload/LICENSE)에 따라 오픈 소스로 제공됩니다.
- 모델 가중치, 캐릭터 팩 및 서드파티 리소스는 각각의 원 라이선스를 따릅니다.
- 타인의 목소리를 학습하거나 음성 합성에 사용하기 전에 권리자의 허가를 받고 현지 법규를 준수하십시오.

## 감사의 글

GPT-SoVITS Fabric 개발에 기반이 된 다음 오픈 소스 프로젝트에 감사드립니다:

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — 핵심 음향 모델 및 업스트림 기반
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Vulkan 추론 엔진 지원
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — 데스크톱 아키텍처 및 UI 기반
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — 보컬 분리 엔진 및 모델 출처
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — 오디오 처리 및 분할
