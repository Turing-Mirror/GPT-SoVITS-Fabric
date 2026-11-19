<div align="center">

<img src="app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](./README.md)　·　繁體中文　·　[English](./README_en.md)　·　[日本語](./README_ja.md)　·　[한국어](./README_ko.md)　·　[Español](./README_es.md)　·　[Français](./README_fr.md)　·　[Русский](./README_ru.md)
<!-- lang-nav -->

**Windows 語音合成與角色聲音訓練軟體**

以 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 為基礎開發，由 [圖靈鏡 Turing Mirror](https://github.com/Turing-Mirror) 維護。

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](./app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[GitHub 倉庫](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [CNB 製品下載](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**社群媒體**　[嗶哩嗶哩 @圖靈鏡](https://space.bilibili.com/3546871148579062)　·　[抖音 @圖靈鏡](https://v.douyin.com/6NxXcrKK9cc)（抖音號 `TuringMirror`）　·　[小紅書 @圖靈鏡](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094)（小紅書號 `TuringMirror`）　·　[YouTube @圖靈鏡](https://www.youtube.com/@TuringMirror)（YouTube 帳號 `@TuringMirror`）　·　QQ 群 @圖靈鏡社區（群號 `1077458748`）

<img src="app/src/assets/qq_group.jpg" alt="QQ 群 QR Code" width="200">

</div>

---

## 介面截圖

![首頁](docs/screenshots/home.png)

![語音合成](docs/screenshots/synthesis.png)

## 專案簡介

GPT-SoVITS Fabric 是圖靈鏡基於 GPT-SoVITS 開發的免費開源 Windows 桌面軟體，將文字轉語音合成、角色聲音管理、標註校對、人聲分離與模型訓練整合到一個獨立用戶端中。使用者無需自行設定 Python 環境或開啟瀏覽器網頁端，安裝後即可在軟體內依引導下載執行環境與基礎模型並開始使用。

## 核心特性

- **語音合成**：支援單筆與批次文字合成，可從角色關聯的 `.list` 標註中選擇 3 至 10 秒的參考音訊，支援輔助參考融合、串流輸出、依角色儲存參數預設，以及匯出 WAV 和 FLAC 音訊。
- **推理引擎**：預設透過內嵌 Python 執行環境在 CUDA 或 CPU 上推理，支援 v1、v2、v2Pro、v2ProPlus、v3、v4、v5dev 與 v5turbo 角色；也可視需要下載 Vulkan 資源，透過 [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) 在 Windows 上執行 v5turbo 的中文和日文合成。
- **角色庫管理**：將 SoVITS 權重、GPT 權重、參考音訊、`.list` 標註、封面圖片與推薦參數作為角色包管理，支援匯入、批次匯出、資料編輯、封面裁切與權重更換。
- **標註與素材處理**：內建 `.list` 標註編輯器，可在儲存前檢查缺失音訊、空白文字、重複項目和語種記號；整合人聲分離、音訊切分與自動轉寫工具，用於整理訓練素材與合成參考。
- **模型訓練**：提供從素材準備到 SoVITS 與 GPT 微調的完整流程，開放 v2、v2Pro、v2ProPlus、v4、v5dev 與 v5turbo 版本訓練，並支援序列訓練佇列與中斷後恢復。
- **社群與資源取得**：支援在社群頁面瀏覽並下載角色包、引擎基礎資源、各版本底模和人聲分離模型，支援多執行緒下載與斷點續傳，並可登入圖靈鏡帳號提交和更新角色投稿。
- **本機 API 與 MCP**：隨包提供獨立背景服務與 `gpt-sovits-fabric-mcp.exe`，可供本機程式或支援 MCP 的用戶端查詢角色並發起語音合成任務，詳細說明見 [API v1](docs/api-v1.md)。

## 快速開始

1. 安裝 GPT-SoVITS Fabric，首次啟動後依新手引導下載執行環境（NVIDIA 顯示卡選擇 CUDA 版，其餘選擇 CPU 版）與引擎基礎資源。
2. 前往「社群」下載公開角色包，或在「模型」頁匯入本機角色包；如需訓練自己的角色，可先在「訓練」頁準備素材並完成微調。
3. 開啟「合成」，選擇角色與對應的 3 至 10 秒參考音訊，輸入文字並選擇推理引擎後開始合成。
4. 如需接入外部程式或模型上下文協定（MCP）用戶端，可參考 [API v1](docs/api-v1.md) 設定 `gpt-sovits-fabric-mcp.exe` 或使用 `--headless` 啟動背景服務。

## 技術架構與開發

### 架構

GPT-SoVITS Fabric 採用 **Tauri + Rust + React** 桌面外殼，推理與訓練計算由背景行程承擔。CUDA 推理、模型訓練和人聲分離透過內嵌 Python Worker 執行，Vulkan 推理透過本機 `gsv.cpp` 服務運作，桌面介面與本機 API 共用同一套任務流程和輸出記錄：

```text
GPT-SoVITS Fabric.exe (Tauri + Rust + React 桌面端與本機 API)
    ├─ CUDA / 訓練 / 分離 ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Vulkan 合成        ─> gsv_server.exe (gsv.cpp，支援 v5turbo)
```

上游 Gradio WebUI（`webui.py`）隨包保留，需要時可在「其他」頁啟動。

### 環境要求與開發

**環境要求**：Windows 10/11 · Node.js 20+ · Rust Stable（`x86_64-pc-windows-msvc`）· Visual Studio C++ 建置工具與 WebView2 · Python 3.12+（建置腳本）

```powershell
# 1. 安裝前端依賴並建置頁面
cd app
npm ci
npm run build

# 2. 組裝開發用產品根並啟動桌面端（在 Visual Studio Developer PowerShell 中執行）
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

僅預覽前端頁面可在 `app/` 下執行 `npm run dev`。詳細建置步驟、依賴編譯排錯與設計約定見 [Windows 開發 v1](docs/development-v1.md) 和 [設計決策記錄](docs/DECISIONS.md)。

### 建置與測試

- **前端單元測試與檢查**：`cd app && npm test`、`npm run build`
- **Rust 單元測試**：`cd app/src-tauri && cargo test --locked --lib`
- **打包安裝程式（NSIS）**：`python scripts/build_setup.py`（或 `cd app && npm run tauri:build`）
- **跟進上游原始碼**：`python scripts/prepare_engine_payload.py --upstream <上游倉> --runtime <Runtime>`
- **建置 Runtime**：`python scripts/build_runtime.py --variant nvidia`（或 `cpu`）
- **打包基礎底模**：`python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **編譯線上清單**：`python scripts/build_catalog.py --sources <發布倉>/catalog/sources.json --out <發布倉>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## 開源授權與聲音授權

- 本專案原始碼採用 [MIT License](./app/src-tauri/engine-payload/LICENSE) 許可協議開源。
- 模型權重、角色包及第三方資源遵循其原始許可協議。
- 使用他人聲音進行訓練或語音合成前，請取得聲音權利人的授權，並遵守當地法律法規。

## 致謝

感謝以下開源專案為 GPT-SoVITS Fabric 提供的技術支援：

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — 核心聲學模型與上游基礎
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Vulkan 推理引擎支援
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — 桌面端架構與介面基礎
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — 人聲分離引擎與模型來源
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — 音訊處理與切分
