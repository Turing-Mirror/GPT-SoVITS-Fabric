# 设计决策记录

状态标记：`[已定]` / `[待定]`

## D1 仓库与发布 [已定]

- 代码仓：本仓库（GPT-SoVITS-Fabric），独立项目。
- 发布仓：GPT-SoVITS-Fabric-Releases（CNB），承担：Setup 制品、Runtime Release 附件、engine-core、角色包 LFS、在线 catalog（git raw）。
- RVC-Fabric 仓库**只读参考，禁止改动**；基础设施 bug 修复在新仓重做。

## D2 总体架构 [已定]

- 复用 RVC-Fabric 三层架构：Tauri(Rust) 壳 + Python Worker，JSON 文件协议 + stdout 行协议。
- 推理内核：常驻 worker 直接 `import GPT_SoVITS.TTS_infer_pack.TTS`，不走 api_v2.py HTTP（避免端口/防火墙）；api_v2 作为高级功能保留入口。
- 显存管理在 Python worker 内（模型 LRU 缓存、热切换、显存不足自动卸载）。
- 长文本/批量队列由 Rust 侧编排（逐句喂 worker），复用 cancel/进度事件模式。

## D3 Runtime [已定]

- 自建新 Runtime：Python 3.10 + torch cu12x，满足最新上游依赖（transformers>=4.51, funasr>=1.3.7）。
- 变体仅 nvidia + cpu 两个（上游无 DirectML 路径）。
- 首启补全复用 provision 管线；底模按版本组 extras（hubert/roberta/s1v3/v2Pro(+)/v4+vocoder/sv/UVR5/ASR）。

## D4 角色包格式 [草案 v0.2 —— .list 为核心]

```
<id>_voice.zip
├─ config.json        # id/name/author/author_url/date/cover/version(v2ProPlus…)
│                     # lists: [{file, lang, note}] 声明包内标注文件
├─ cover.jpg
├─ models/
│  ├─ sovits.pth
│  └─ gpt.ckpt
└─ dataset/
   ├─ <id>.list       # 相对路径标注：audios/xxx.wav|说话人|语种|文本
   └─ audios/
```

- `.list` 同时服务：合成台参考音频挑选器（行=候选参考，带文本稿+语种）、训练台数据集（直接喂格式化工具）。
- 包内路径一律相对包根（禁止绝对路径）。
- 支持语种子集命名约定 `<id>_JP.list` / `<id>_ZH.list`（沿用现有素材库习惯）。
- [待定] params.json（top_k/top_p/temperature/speed 默认值）是否入包。

## D5 版本矩阵 [草案]

- UI 默认 v2ProPlus；推理支持加载 v1/v2/v2Pro/v2ProPlus/v4。
- 训练台初期开放版本范围 [待定]（需对照 s2_train_v3_lora.py 确认 v3/v4 LoRA 路径）。

## D6 里程碑 [草案]

- M0 骨架：壳工程派生 + engine payload 清单 + provision/底模下载打通
- M1 合成台 MVP：worker + 角色库 + 文本合成/试听/导出
- M2 训练闭环：数据集工具链(UVR5→切片→ASR打标→校对) + 双微调 + 进度恢复
- M3 广场：catalog 编译管线 + 角色包打包脚本 + 第三方源协议
- M4 打磨发布：NSIS 薄包 + i18n + CNB 发布链路
