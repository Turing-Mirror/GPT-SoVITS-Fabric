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

## D4 角色包格式 [已定 v0.3 —— .list 为核心]

```
<id>_voice.zip
├─ config.json        # id/name/author/author_url/date/cover/version(v2ProPlus…)
│                     # lists: [{file, lang, note}] 声明包内标注文件
│                     # params: {top_k, top_p, temperature, repetition_penalty, speed}
│                     #         （作者推荐值；可整体省略；未知字段忽略；加载时范围钳制；
│                     #          用户在 UI 改过则以用户本地持久化值为准）
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
- params 只收音质调校知识（采样类 + 可选 speed）；设备相关项（batch_size、流式阈值等）禁止入包。

## D5 版本矩阵 [已定]

- UI 默认 v2ProPlus。
- **推理**支持加载 v1/v2/v2Pro/v2ProPlus/v3/v4 —— 版本不用我们告诉它：
  上游 `TTS.init_vits_weights` 从检查点里 `enc_p.text_embedding.weight` 的形状
  自己认（TTS.py 505-522）。
- **训练**只开 `v2ProPlus / v2Pro / v2` 三个（`train.rs` 的 `TRAIN_VERSIONS`，
  前端的下拉直接取它，不再各写一份）。v3/v4 走的是 `s2_train_v3_lora.py`
  那条 LoRA 路径，与 `s2_train.py` 不是同一套参数与产物，要开得单独做；
  v1 的底模上游已不再随包发。
- v2Pro / v2ProPlus 的训练比其余版本**多一步**：`2-get-sv.py` 产出 `7-sv_cn`
  说话人验证嵌入。判据与上游一致（`if "Pro" in version`）。这一步不是可选的 ——
  缺了不报错，`module/data_utils.py` 会拿全零张量顶上把训练跑完，交出一个
  说话人嵌入全为零的废模型。
- v2Pro / v2ProPlus 的 s2 配置模板是 `s2v2Pro(Plus).json`，不是 `s2.json`：
  两者差的是网络结构（`gin_channels` 512↔1024、`upsample_initial_channel`
  512↔768），拿错模板建出来的网络和底模对不上。

## D6 里程碑 [草案]

- M0 骨架：壳工程派生 + engine payload 清单 + provision/底模下载打通
- M1 合成台 MVP：worker + 角色库 + 文本合成/试听/导出
- M2 训练闭环：数据集工具链(UVR5→切片→ASR打标→校对) + 双微调 + 进度恢复
- M3 广场：catalog 编译管线 + 角色包打包脚本 + 第三方源协议
- M4 打磨发布：NSIS 薄包 + i18n + CNB 发布链路

进度（26.8.29）：软件侧 M1/M2 的界面与接线已经全通 —— 合成台、角色库、
训练台、人声分离都接到了各自的命令上，前端从没调用过的已注册命令从 23 个
降到 3 个（那三个是基础设施）。**尚未做的是发布侧**：`scripts/` 目录还是空的
（没有 build_setup / build_catalog / publish_asset / prepare_engine_payload），
发布仓 `GPT-SoVITS-Fabric-Releases` 只有 156K 的 `.gitkeep` 骨架，没有
`index.json`，`catalog-src/*.yaml` 的 sha256 全空。也就是说这个产品目前
构建不出安装包，Runtime 与底模也无源可下。M0 的「provision/底模下载打通」
在代码侧成立，在制品侧还没有。

## D7 UI/UX 继承 [已定]

从 RVC-Fabric 原样沿用（只读复制后改造，不回写）：

- **设计令牌**（app/src/index.css）：Schale 浅蓝体系、`--accent #1289f0`、明暗双主题
  （data-theme + prefers-color-scheme）、14/8px 圆角、玻璃拟态 --glass、原生控件
  color-scheme 联动、换页缓动 --ease-nav。令牌注释文化一并保留。
- **组件语言**：controls.tsx / ui.tsx / SegmentControl / Tooltip / TitleBar / Dock /
  PageHost 全套复用。
- **说明页模式**（HelpPage.tsx）：锚点 Block 手风琴（HELP_ANCHORS 深链）、首次运行
  FAQ、功能分指南（合成/训练/角色包安装）、术语表 glossary、动态个性化内容
  （RVC 版检测用户声卡画接线图；GSV 版对应=按显存/显卡推荐版本与默认参数）、
  DonateNote。内容全部按 GPT-SoVITS 重写。
- **引导体系**：OnboardingBar 新手进度、Nudge 提醒、FindingList 自检发现、
  TuningWizard 调校向导思想 → 改造为合成/训练调优向导。
