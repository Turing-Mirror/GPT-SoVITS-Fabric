<div align="center">

<img src="app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](./README.md)　·　[繁體中文](./README_zh-TW.md)　·　English　·　[日本語](./README_ja.md)　·　[한국어](./README_ko.md)　·　[Español](./README_es.md)　·　[Français](./README_fr.md)　·　[Русский](./README_ru.md)
<!-- lang-nav -->

**Text-to-speech synthesis and voice training desktop application for Windows**

Based on [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) and maintained by [Turing Mirror](https://github.com/Turing-Mirror).

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](./app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[GitHub Repository](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [CNB Artifacts Download](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**Social Media**　[Bilibili @Turing Mirror](https://space.bilibili.com/3546871148579062)　·　[Douyin @Turing Mirror](https://v.douyin.com/6NxXcrKK9cc) (Douyin ID `TuringMirror`)　·　[Xiaohongshu @Turing Mirror](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094) (Xiaohongshu ID `TuringMirror`)　·　[YouTube @Turing Mirror](https://www.youtube.com/@TuringMirror) (YouTube handle `@TuringMirror`)　·　QQ Group @Turing Mirror Community (Group ID `1077458748`)

<img src="app/src/assets/qq_group.jpg" alt="QQ group QR code" width="200">

</div>

---

## Project Introduction

GPT-SoVITS Fabric is a free, open-source Windows desktop application developed by Turing Mirror on top of GPT-SoVITS. It brings text-to-speech synthesis, character voice management, `.list` annotation editing, vocal separation, and model training together into a standalone desktop client. You do not need to configure a Python environment or open a browser WebUI manually; after installation, the onboarding guide downloads the required runtime and base models for you.

## Core Features

- **Speech Synthesis**: Supports single and batch text synthesis, selects 3 to 10 second reference audio clips from linked `.list` annotations, and supports auxiliary reference mixing, streaming output, per-character parameter presets, and WAV or FLAC export.
- **Inference Backends**: Runs on CUDA or CPU through the embedded Python runtime by default for `v1`, `v2`, `v2Pro`, `v2ProPlus`, `v3`, `v4`, `v5dev`, and `v5turbo` characters; also supports optional Vulkan resources via [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) on Windows for Chinese and Japanese `v5turbo` synthesis.
- **Character Library**: Manages SoVITS weights, GPT weights, reference recordings, `.list` annotations, cover images, and recommended parameters as character packages, with import, batch export, metadata editing, cover cropping, and weight replacement.
- **Annotations and Dataset Preparation**: Includes a built-in `.list` annotation editor that validates missing audio files, empty text, duplicate entries, and language tags before saving, along with vocal separation, audio slicing, and ASR transcription tools.
- **Model Training**: Covers dataset preparation and SoVITS/GPT fine-tuning for `v2`, `v2Pro`, `v2ProPlus`, `v4`, `v5dev`, and `v5turbo`, with a serial training queue and interruption recovery.
- **Community and Resources**: Browse and download character packs, base engine assets, version-specific pretrained models, and vocal separation models with multi-connection resumable downloads; sign in with a Turing Mirror account to submit and update character publications.
- **Local API and MCP**: Includes a standalone local API and `gpt-sovits-fabric-mcp.exe` so local applications and MCP clients can query characters and run synthesis tasks. See [API v1](docs/api-v1.md) for details.

## Quick Start

1. Install GPT-SoVITS Fabric and follow the first-run guide to download the runtime (choose CUDA for NVIDIA GPUs or CPU otherwise) and the base engine assets.
2. Open **Community** to download a public character pack, or import a local package in **Models**; to create your own voice, prepare a dataset and fine-tune it in **Train**.
3. Open **Synthesize**, select a character and a 3 to 10 second reference clip, enter your text, choose an inference backend, and generate audio.
4. To integrate with external tools or an MCP client, see [API v1](docs/api-v1.md) to configure `gpt-sovits-fabric-mcp.exe` or start the service with `--headless`.

## Technical Architecture and Development

### Architecture

GPT-SoVITS Fabric uses a **Tauri + Rust + React** desktop shell, while inference and training run in background processes. CUDA inference, training, and vocal separation run through embedded Python workers, and Vulkan synthesis runs through a local `gsv.cpp` server. The desktop UI and local API share the same task flow and output records:

```text
GPT-SoVITS Fabric.exe (Tauri + Rust + React desktop app & local API)
    ├─ CUDA / Training / Separation ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Vulkan Synthesis             ─> gsv_server.exe (gsv.cpp for v5turbo)
```

The upstream Gradio WebUI (`webui.py`) is retained in the package and can be launched from the **More** page.

### Requirements and Development

**Requirements**: Windows 10/11 · Node.js 20+ · Rust Stable (`x86_64-pc-windows-msvc`) · Visual Studio C++ Build Tools & WebView2 · Python 3.12+ (build scripts)

```powershell
# 1. Install frontend dependencies and build the UI
cd app
npm ci
npm run build

# 2. Assemble a development product root and launch the app (in Visual Studio Developer PowerShell)
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

To preview the frontend in a browser only, run `npm run dev` inside `app/`. See [Windows Development v1](docs/development-v1.md) and [Design Decisions](docs/DECISIONS.md) for detailed build steps, troubleshooting, and architecture notes.

### Build and Test

- **Frontend tests and build**: `cd app && npm test`, `npm run build`
- **Rust unit tests**: `cd app/src-tauri && cargo test --locked --lib`
- **Package installer (NSIS)**: `python scripts/build_setup.py` (or `cd app && npm run tauri:build`)
- **Sync upstream engine payload**: `python scripts/prepare_engine_payload.py --upstream <upstream-repo> --runtime <Runtime>`
- **Build Runtime**: `python scripts/build_runtime.py --variant nvidia` (or `cpu`)
- **Build base model packs**: `python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **Build online catalog**: `python scripts/build_catalog.py --sources <releases-repo>/catalog/sources.json --out <releases-repo>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## License and Voice Authorization

- The source code of this project is licensed under the [MIT License](./app/src-tauri/engine-payload/LICENSE).
- Model weights, character packs, and third-party assets remain subject to their original licenses.
- Obtain authorization from the voice rights holder before training or synthesizing someone else's voice, and comply with applicable local laws.

## Acknowledgments

Thank you to the following open-source projects for supporting GPT-SoVITS Fabric:

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — Core acoustic models and upstream foundation
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Vulkan inference engine support
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — Desktop shell architecture and UI foundation
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — Vocal separation engine and model sources
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — Audio processing and slicing
