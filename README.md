# GPT-SoVITS Fabric

**开箱即用的 GPT-SoVITS 桌面客户端** —— 由 [图灵镜 Turing Mirror](https://cnb.cool/Turing-Mirror) 开发维护。

基于 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 深度定制，UI/UX 逻辑承自 [Turing-Mirror/RVC-Fabric](https://github.com/Turing-Mirror/RVC-Fabric)（只读参考，独立演进）。

## 定位

- 不装 Python、不开浏览器、不碰命令行：安装即合成
- 角色库 + 合成台 + 训练台 + 社区广场（CNB 分发）一站式
- `.list` 标注文件一等公民：同一份标注贯穿「广场分发 → 本地角色库 → 合成参考 → 训练数据集」

## 架构（草案）

```
GPT-SoVITS Fabric.exe (Tauri + Rust + React)
    │ JSON 文件协议 / stdout 行协议
Runtime\pythonw.exe tools\synth_worker.py --resident
    └─> GPT_SoVITS.TTS_infer_pack.TTS（进程内常驻推理）
```

## 开发

见 `docs/DECISIONS.md`（设计决策记录）。

`cd app && npm run tauri:dev` 起的是壳。壳需要 `TM_VOICE_ROOT` 指到一个
组装好的产品根（`Runtime/` + `tools/` + `GPT_SoVITS/` + `setup_package.json`，
内容来自 `app/src-tauri/engine-payload/` 加发布的 Runtime/engine-core 包）；
没指的话壳会退到 cwd，页面能看、合成/训练/分离跑不起来。
