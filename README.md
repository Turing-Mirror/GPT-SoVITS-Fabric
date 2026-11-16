# GPT-SoVITS Fabric

**开箱即用的 GPT-SoVITS 桌面客户端** —— 由 [图灵镜 Turing Mirror](https://cnb.cool/Turing-Mirror) 开发维护。

基于 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 深度定制，UI/UX 逻辑承自 [Turing-Mirror/RVC-Fabric](https://github.com/Turing-Mirror/RVC-Fabric)（只读参考，独立演进）。

## 定位

- 不装 Python、不开浏览器、不碰命令行：安装即合成
- 角色库、合成台、训练台与社区
- `.list` 标注文件一等公民：同一份标注贯穿「广场分发 → 本地角色库 → 合成参考 → 训练数据集」

## 推理引擎

在「合成」页选择推理引擎。CUDA 是默认选项，沿用现有运行环境和模型。Vulkan 使用 [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp)，首版支持 Windows 上的 v5turbo 中文和日文合成，使用一条参考音频并输出完整 WAV。

可在合成页或「广场 → 下载模型 → 引擎资源」下载 Vulkan 推理资源。首次合成时，程序为当前角色准备 GGUF 缓存。可在「其他 → 存储占用」清理 Vulkan 缓存，再次使用相应角色时会重建。使用旧版角色、辅助参考、流式合成或 FLAC 时，选择 CUDA。当前任务不适用 Vulkan 时，可直接点击「用 CUDA 合成」。

## 架构

```
GPT-SoVITS Fabric.exe（Tauri + Rust + React）
├─ CUDA → 常驻 Python worker → GPT-SoVITS TTS
└─ Vulkan → 本机 gsv.cpp 服务与文本进程 → GPT-SoVITS v5turbo
```

两套引擎共用合成入口、取消操作和输出记录。桌面与本机 API 使用同一任务流程。

## 开发

见 [设计决策记录](docs/DECISIONS.md) 与 [Windows 开发 v1](docs/development-v1.md)。

桌面壳加载构建后的 `frontend/`。壳需要 `TM_VOICE_ROOT` 指到一个
组装好的产品根（`Runtime/` + `tools/` + `GPT_SoVITS/` + `setup_package.json`，
内容来自 `app/src-tauri/engine-payload/` 加发布的 Runtime/engine-core 包）；
没指的话壳会退到 cwd，页面能看、合成/训练/分离跑不起来。

本地产物统一放在 `data/`（不入库）：

| 用途 | 命令 |
| --- | --- |
| 跟进上游 | `python scripts/prepare_engine_payload.py --upstream <上游仓> --runtime <Runtime>` |
| 构建 Runtime | `python scripts/build_runtime.py --variant nvidia`（或 `cpu`） |
| 打 engine-core | `python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>` |
| 编译清单 | `python scripts/build_catalog.py --sources <发布仓>/catalog/sources.json --out <发布仓>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json` |
| 组装开发用产品根 | `python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>`，之后设 `TM_VOICE_ROOT=data/dev-root` |

`dev_root.py` 不带参数再跑一次只同步 `engine-payload`，模型与 Runtime 用目录联接，不复制。

## Local API (Neptune)

The Neptune branch includes an independent local API and bundled MCP server. See [API v1](docs/api-v1.md) for discovery, capabilities, tasks, and standalone use.
