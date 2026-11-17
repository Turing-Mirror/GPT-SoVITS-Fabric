<div align="center">

<img src="app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](./README.md)　·　[繁體中文](./README_zh-TW.md)　·　[English](./README_en.md)　·　日本語　·　[한국어](./README_ko.md)　·　[Español](./README_es.md)　·　[Français](./README_fr.md)　·　[Русский](./README_ru.md)
<!-- lang-nav -->

**Windows 向け音声合成・キャラクターボイス学習ソフトウェア**

[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) を基に開発し、[图灵镜 Turing Mirror](https://github.com/Turing-Mirror) が保守しています。

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](./app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[GitHub リポジトリ](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [CNB 成果物ダウンロード](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**ソーシャルメディア**　[bilibili @图灵镜](https://space.bilibili.com/3546871148579062)　·　[抖音 @图灵镜](https://v.douyin.com/6NxXcrKK9cc)（抖音 ID `TuringMirror`）　·　[小紅書 @图灵镜](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094)（小紅書 ID `TuringMirror`）　·　[YouTube @图灵镜](https://www.youtube.com/@TuringMirror)（YouTube ハンドル `@TuringMirror`）　·　QQ グループ @图灵镜社区（グループ番号 `1077458748`）

<img src="app/src/assets/qq_group.jpg" alt="QQ グループの QR コード" width="200">

</div>

---

## プロジェクト概要

GPT-SoVITS Fabric は Turing Mirror が GPT-SoVITS を基に開発する無料のオープンソース Windows デスクトップアプリです。テキスト音声合成、キャラクター音声管理、`.list` 注釈の校正、ボーカル分離、モデル学習を一つのスタンドアロンクライアントに統合しています。Python 環境を個別に構築したりブラウザで WebUI を開いたりする必要はなく、インストール後の案内に従って実行環境とベースモデルを取得してすぐ使い始められます。

## 主な特徴

- **音声合成**：単文および一括テキスト合成に対応し、キャラクターに紐づく `.list` 注釈から 3〜10 秒の参照音声を選択できます。補助参照のブレンド、ストリーミング出力、キャラクターごとのパラメーター保存、WAV・FLAC 書き出しに対応しています。
- **推論エンジン**：標準では内蔵 Python 実行環境を用いた CUDA または CPU 推論を行い、`v1` / `v2` / `v2Pro` / `v2ProPlus` / `v3` / `v4` / `v5dev` / `v5turbo` の各キャラクターに対応しています。必要に応じて Vulkan リソースをダウンロードし、[gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) により Windows 上で `v5turbo` の中国語・日本語合成を実行できます。
- **キャラクター管理**：SoVITS 重み、GPT 重み、参照音声、`.list` 注釈、カバー画像、推奨パラメーターをキャラクターパックとして管理し、インポート、一括エクスポート、情報編集、カバーのトリミング、重みの差し替えに対応しています。
- **注釈・素材処理**：内蔵の `.list` 注釈エディターで音声欠損、空テキスト、重複行、言語タグを保存前に検査できます。学習素材や参照音声の整理に使えるボーカル分離、音声分割、自動文字起こしツールを備えています。
- **モデル学習**：素材準備から SoVITS・GPT のファインチューニングまでを一貫して行えます。`v2`、`v2Pro`、`v2ProPlus`、`v4`、`v5dev`、`v5turbo` の学習に対応し、順次実行キューと中断後の再開を備えています。
- **コミュニティとリソース取得**：コミュニティ画面で公開キャラクターパック、エンジン基本リソース、各バージョンのベースモデル、ボーカル分離モデルを閲覧してマルチスレッド・レジューム対応でダウンロードできます。Turing Mirror アカウントでログインするとキャラクターの投稿や更新を行えます。
- **ローカル API と MCP**：独立したバックグラウンドサービスと `gpt-sovits-fabric-mcp.exe` を同梱しており、ローカルアプリや MCP クライアントからキャラクター照会や音声合成を実行できます。詳細は [API v1](docs/api-v1.md) を参照してください。

## クイックスタート

1. GPT-SoVITS Fabric をインストールし、初回起動時の案内に従って実行環境（NVIDIA GPU は CUDA 版、それ以外は CPU 版）とエンジン基本リソースをダウンロードします。
2. 「コミュニティ」から公開キャラクターパックをダウンロードするか、「モデル」画面でローカルのキャラクターパックをインポートします。独自の音声を作る場合は「学習」画面で素材を準備して学習を行います。
3. 「合成」を開き、キャラクターと 3〜10 秒の参照音声を選び、テキストを入力して推論エンジンを選択してから合成を開始します。
4. 外部アプリや MCP クライアントと連携する場合は、[API v1](docs/api-v1.md) を参照して `gpt-sovits-fabric-mcp.exe` を設定するか、`--headless` でバックグラウンドサービスを起動します。

## 技術アーキテクチャと開発

### アーキテクチャ

GPT-SoVITS Fabric は **Tauri + Rust + React** のデスクトップシェルを採用し、推論と学習の計算はバックグラウンドプロセスで実行します。CUDA 推論・学習・ボーカル分離は内蔵 Python Worker で動作し、Vulkan 合成はローカルの `gsv.cpp` サーバーで動作します。デスクトップ UI とローカル API は同じタスク制御と出力履歴を共有します：

```text
GPT-SoVITS Fabric.exe (Tauri + Rust + React デスクトップ本体とローカル API)
    ├─ CUDA / 学習 / 分離 ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Vulkan 合成        ─> gsv_server.exe (gsv.cpp、v5turbo 対応)
```

上流の Gradio WebUI（`webui.py`）も同梱されており、必要な場合は「その他」画面から起動できます。

### 環境要件と開発

**環境要件**：Windows 10/11 · Node.js 20+ · Rust Stable（`x86_64-pc-windows-msvc`）· Visual Studio C++ ビルドツールおよび WebView2 · Python 3.12+（ビルドスクリプト用）

```powershell
# 1. フロントエンド依存のインストールとビルド
cd app
npm ci
npm run build

# 2. 開発用プロダクトルートを組み立てて起動（Visual Studio Developer PowerShell で実行）
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

ブラウザ上で UI のみ確認する場合は `app/` で `npm run dev` を実行してください。ビルド手順の詳細やトラブルシューティング、設計方針は [Windows 開発 v1](docs/development-v1.md) および [設計判断記録](docs/DECISIONS.md) を参照してください。

### ビルドとテスト

- **フロントエンドのテストとビルド**：`cd app && npm test`、`npm run build`
- **Rust 単体テスト**：`cd app/src-tauri && cargo test --locked --lib`
- **インストーラー作成（NSIS）**：`python scripts/build_setup.py`（または `cd app && npm run tauri:build`）
- **上流ソースの同期**：`python scripts/prepare_engine_payload.py --upstream <上流リポジトリ> --runtime <Runtime>`
- **Runtime のビルド**：`python scripts/build_runtime.py --variant nvidia`（または `cpu`）
- **ベースモデルパックの作成**：`python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **オンラインカタログの生成**：`python scripts/build_catalog.py --sources <リリースリポジトリ>/catalog/sources.json --out <リリースリポジトリ>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## ライセンスと音声の利用許諾

- 本プロジェクトのソースコードは [MIT License](./app/src-tauri/engine-payload/LICENSE) の下で公開されています。
- モデルの重み、キャラクターパック、サードパーティのリソースはそれぞれの元のライセンスに従います。
- 他人の声を学習や音声合成に使用する前に権利者の許諾を取得し、現地の法令を遵守してください。

## 謝辞

GPT-SoVITS Fabric を支える以下のオープンソースプロジェクトに感謝します：

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — コア音響モデルと上流基盤
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Vulkan 推論エンジン対応
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — デスクトップ構成と UI 基盤
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — ボーカル分離エンジンと分離モデル提供元
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — 音声処理と分割
