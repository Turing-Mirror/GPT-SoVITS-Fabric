# 设计决策记录

状态标记：`[已定]` / `[待定]`

## D1 仓库与发布 [已定]

- 代码仓：本仓库（GPT-SoVITS-Fabric），独立项目。
- 发布仓：GPT-SoVITS-Fabric-Releases（CNB），承担：Setup 制品、Runtime Release 附件、engine-core、角色包 LFS、在线 catalog（git raw）。
- RVC-Fabric 仓库**只读参考，禁止改动**；基础设施 bug 修复在新仓重做。

## D2 总体架构 [已定]

- 复用 RVC-Fabric 三层架构：Tauri(Rust) 壳 + Python Worker，JSON 文件协议 + stdout 行协议。
- 推理内核：常驻 worker 直接 `import GPT_SoVITS.TTS_infer_pack.TTS`，不走 api_v2.py HTTP（避免端口/防火墙）；api_v2 作为高级功能保留入口。
- 显存管理在 Python worker 内：同一时刻只驻留一个角色，换角色即热切换；显存不足时释放缓存并报 `oom`。
- 上游的模块搜索路径、DLL 目录与工作目录由 `tools/portable_runtime.activate()` 设置，worker 首次加载模型前调用；上游的 `print` 改走 stderr，stdout 只留给行协议。
- 长文本/批量队列由 Rust 侧编排（逐句喂 worker），复用 cancel/进度事件模式。

## D3 Runtime [已定]

- 自建 Runtime：Python 3.12.10（nuget 完整版，含 `include/` 与 `libs/`，triton 编译需要）+ torch 2.7.1。依赖取上游 `requirements_py312_win_cu128_china.txt`，整理为 `scripts/runtime/requirements_{nvidia,cpu}.txt`。
- 变体仅 nvidia（cu128）+ cpu 两个（上游无 DirectML 路径）。cpu 版去掉 flash-attn、triton、onnxruntime-gpu。
- 构建：`python scripts/build_runtime.py --variant nvidia|cpu`。构建时预取 NLTK 数据与 pyopenjtalk 词典（否则首次日语合成要在线下载，实测 145 秒），并放入 ffmpeg/ffprobe，打成 `runtime-<变体>-<日期>.tar.gz`（去掉 `torch/lib/*.lib`）。
- 首启补全复用 provision 管线；必装底模为 engine-core 五个包，其余（V5 底模、人声分离模型）为可选 extras。

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

- **版本跟随上游，不写死。** 可训练版本、LoRA 版本、各版本的底模路径与配置
  模板，由 `scripts/prepare_engine_payload.py` 在同步上游时从随包的 `config.py`
  （`pretrained_sovits_name` / `pretrained_gpt_name`）和 `webui.py`（训练页版本
  选项、`v3v4set`）抽出，写成 `engine-payload/configs/upstream_versions.json`。
  壳、train_worker、`pack_role_pack.py` 都读这一份。上游改了版本，重新同步即可。
- **默认值单独一份**：`engine-payload/configs/train_defaults.json`，只放默认版本、
  轮数、保存间隔、按显存算批大小的系数、LoRA 秩。数值取自上游 webui 的
  `set_default` 与训练页滑杆。界面换版本时回到该版本的默认值，用户可改。
- **默认版本 v5dev。** v5turbo 推理更快，但上游 #2857（连续推理 CUDA 非法访存）
  未修，而合成 worker 正是常驻连续推理。
- **推理**支持上游认得的全部版本，版本由上游 `TTS.init_vits_weights` 从检查点
  自己认。V5（`v5dev` / `v5turbo`，48 kHz 输出）底模 `gsv-v5-pretrained`
  作为可选 extras `gsv-v5`，不进 engine-core。
- **训练**开放上游训练页的全部版本（当前 v2 / v2Pro / v2ProPlus / v4 / v5dev /
  v5turbo）。`v3v4set` 里的版本走 `s2_train_v3_lora.py`（LoRA，无判别器底模，
  检查点在 `logs_s2_<版本>_lora_<秩>`），其余走 `s2_train.py`。SoVITS 与 GPT 两段
  的轮数、批大小、保存间隔分开设。所选版本的底模不在盘上时，预检拦下并提示
  去「广场 → 下载模型」。
- **参考音频须 3–10 秒**（上游硬性检查）。合成台读取每条参考的时长，超出范围
  的置灰；worker 把上游的报错转成 `synth.ref_length`。
- v2Pro / v2ProPlus 的训练比其余版本**多一步**：`2-get-sv.py` 产出 `7-sv_cn`
  说话人验证嵌入。判据与上游一致（版本名带 Pro，版本表的 `needs_sv`）。这一步不是可选的 ——
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
降到 3 个（那三个是基础设施）。发布链路（M4 的一半）也搭完了：`scripts/`
八个脚本、发布仓目录与流程文档就位，除了「真的把制品传上去」之外全部可跑。

**还差的是制品本身**：Runtime（nvidia / cpu）与底模组都没有构建过，
所以 `catalog/sources.json` 里的 sha 全空，`build_catalog.py` 会照章拒绝
出清单 —— 那是设计如此，制品还没有就不该有一份看起来能用的 index.json。
M0 的「provision/底模下载打通」在代码侧成立，在制品侧还没有。

## D7.5 与 RVC 的边界 [已定]

RVC-Fabric 只读参考，**不共用代码**。这一条本来是 D1 的一句话，实际执行时
反复被「先照抄再改」冲掉，所以单列并写清判据：

- **一个功能只要它的产出落在这个产品不读的地方，就删掉，不留着「以后接」。**
  已经踩过三次：广场装的角色落进 `User_Data/models/`（合成台读
  `characters/`）、训练产出散落在 `models/` 下没拼成角色、store 的
  「多文件安装」下单个 .pth。三次的表现完全一样 —— 装好了 / 训完了 /
  下完了，界面上看不见。
- **一个没人调用的函数会吊住它引用的一切。** `lib/voices.ts` 的 21 个死导出
  吊着 19 个命令、63 条文案、2443 行 `voices.rs`；FPS 那边未被调用的
  `tips()` 吊着 39 条变声器文案。四道文案校验只看「字面量在不在源码里」，
  这类漏判必须靠「未引用导出」扫一遍来补。
- **写好了没挂上等于没写。** `StorageSection`（连带训练清理两个命令）、
  `AdBanner`（Rust 一直在返回 banner）都是整个组件从没被 render 过。

## D8 打包与发布 [已定]

- **上游源码随包发，钉在 `UPSTREAM_PIN`**（当前 b4570b8，2026-10-19），不做成可下载
  extras。三个 worker 的契约是对着那个版本逐行核过的（方法名、属性名、
  返回值形状、配置键、产物目录），让它跟壳分开升级就是在等下一轮
  「合成台一次都没跑起来过」。`prepare_engine_payload.py` 会拦着不让漂。
  负载因此从 2.6 MB 涨到 38 MB。
- **`tools/` 是合并布局**：我们的 worker 与上游的 `my_utils` /
  `slice_audio` / `asr` 同住，两边文件名无交集。合并后
  `import tools.my_utils` 与 `python tools/synth_worker.py` 同时成立 ——
  这正是 worker 写的时候假设的布局。
- **engine-core 按上游布局落盘**：`<安装根>/GPT_SoVITS/pretrained_models/`。
  上游源码里写死的相对路径（`sv.py` 的说话人验证权重、vocoder、v3-LoRA
  底模、g2pw 的 `model_source` 缺省值、`fast_langdetect` 的 `cache_dir`）
  全都按 `<cwd>/GPT_SoVITS/...` 解析；把底模放在顶层 `pretrained_models/`
  上游一个都找不到——v2ProPlus 推理会当场死在 `init_sv_model`。sv 权重
  因此归 engine-core 必装，不是训练专属。
- **`bundle.resources` 用带显式落点的对象形态**。数组形态保留相对路径，
  `engine-payload/tools` 会落在 `<安装根>/engine-payload/tools`，
  比 `paths::looks_like_root` 期望的深一层。
- **产品根标记是 `tools/synth_worker.py`**。原来是 `realtime_worker.py`
  （RVC 的实时 worker，从没随包发过），于是根目录识别恒定失败，
  一路落到 `current_dir()`。
- **清单源是单一 JSON**（`catalog/sources.json`），不经 YAML 中转。
  RVC 的 2554 行编译器几乎全在伺候第三方音色收编，这个产品没有那套生态。
- **五条 Release 标签**：`GSV-setup` / `GSV-runtime` / `GSV-engine-core` /
  `GSV-roles` / `GSV-covers`。分开是因为更新节奏完全不同，混在一个标签里
  没法单独重传。封面走 Release 附件不走 git raw（raw 对图片不给正确的
  Content-Type）。
- **engine-core 是五个 zip**：`base-hubert-bert` / `base-gpt-s1v3` /
  `base-v2proplus`（含 sv）/ `base-g2pw` / `base-langdetect`，由
  `scripts/build_engine_core.py` 打出（不压缩，`--v5` 另出 `base-v5.zip`）。
  sha256 写在壳内 `engine_assets.rs` 的 `BASE_MODEL_PACKS`，大小写进清单
  `engine_core` 段供下载器分连接与显示进度。重打任何一个包都要同步两处。
- **清单编译**：`python scripts/build_catalog.py --sources <发布仓>/catalog/sources.json
  --out <发布仓>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`。
  `--bundle` 只覆盖编译出的段，内置清单里的 `community` 等段保留。
  extras 可用 `repo` 指向其他发布仓（人声分离模型目前复用 RVC-Fabric-Releases 的 `pymss` 标签）。
- **日语用户词典在打包时预编译**（`prepare_engine_payload.py --runtime`），
  生成的 `user.dict` / `userdict.md5` 不入库。
- **在线角色包装进 `User_Data/characters/`**，走 `characters::install_zip`
  那条已经有测试的路径。以前装进 `User_Data/models/`（RVC 音色的位置），
  合成台从来不看那里。

## D7 UI/UX 继承 [已定]

组件与设计令牌改用 TRM UI（`Turing-Mirror/TRM-UI`），复制到 `app/src/trm/`：
`components/` 下的 ui / controls / SegmentControl / Tooltip / ErrorBoundary 是对
`../trm/components/*` 的转出；i18n 的语言状态由 TRM 的 `I18nProvider` 持有，产品侧只
补 Tauri 存储、`tMsg` 与术语表；`index.css` 取 TRM 的令牌，颜色一律走令牌。更新 TRM UI
时整目录覆盖 `app/src/trm/`。ErrorNote、TitleBar 仍是产品自有版本。

与 RVC Fabric 当前界面对齐的部分（2026-10-31）：

- **窗口**：`window_watch.rs` 与 RVC 相同。Win11 由 DWM 画圆角与阴影；Win10 保持直角，
  投影由 `DwmExtendFrameIntoClientArea` 找回。不再用 `SetWindowRgn` 裁圆角。
- **焦点环**：TRM 的 `trackInputModality` 在 `<html data-input>` 上记录最近一次输入来自
  指针还是键盘，鼠标操作后不画焦点环。
- **动效**：弹窗共用 `components/Modal.tsx`（进出场动画），条件渲染的弹窗与底部提示
  包在 `Presence.tsx` 的 `Leave` 里，关掉时放完退场再卸下；`PageHost` 用 RVC 版本；
  列表与卡片用 TRM 的 `Swap`（翻页、筛选）与 `stagger`（依次浮现）。
- **分页**：角色卡、参考音频、标注行、角色标注列表都用 TRM 的 `usePaged` + `Pager`，
  条目多时可搜索（`SearchBox`）。
- **新手引导**：`components/SetupGuide.tsx` 基于 TRM 的 `Wizard`，四步（运行环境、
  角色、第一次合成、自己的角色），完成与否按 `onboarding_status` 每两秒读一次。
  第一次打开时先显示反馈须知（QQ 群二维码、GitHub Issue、诊断包），看过写
  `feedback_notice_done`；走完或关掉写 `setup_guide_done`。说明页「首次运行」有入口。
- **页面联动**：`lib/intent.ts` 负责跨页交接。模型页「用于合成」「编辑标注」，合成页
  「编辑标注」，标注页「用于训练」，训练完成后「在模型页查看」。
- **模型页**：改名称与作者、换封面、导出角色包、打开文件夹、删除（`role_update` /
  `role_set_cover` / `role_export` / `role_delete`，见 `characters.rs`）。
- **说明页与其他页**：说明页标题行「联系社区」、常见问题搜索；「其他 → 仓库与社媒」
  第一行是诊断包入口，跳到「维护」。
- **界面加载**：调试版与正式版一样从 exe 旁的 `frontend/` 经自定义协议加载，不连
  `localhost:1430`。改完界面要 `vite build` 并拷到 `target/debug/frontend`。
- **首页横幅**：同 RVC，底色 `--stage`，按「横幅不透明度」混合；标题取「首页横幅
  文案」，下一行是当前合成角色，再下一行是「首页横幅副标题」（留空不显示）。RVC 横幅
  右侧的徽标图不放，本产品还没有自己的徽标图。
- **下拉选择**：`components/controls.tsx` 的 `Select` 改用 TRM 的 `Dropdown`，
  不再弹系统原生列表。
- **三栏页面**：合成页与训练页同 RVC 音频页，`PagePad fill` 让页面占满面板高度，
  宽度 ≥ 900px 时分三栏、各栏内部滚动，更窄时退回单栏整页滚动。
  - 合成页：上方角色条（下拉切换，管理去模型页）；左栏参考音频（试听、加入辅助
    参考）；中栏文本与参数，分「单条 / 批量」，批量逐行顺序合成、可停止、可重试
    失败项、可导入 TXT；右栏合成记录。上游 `TTS.run` 的文本语言、切分方式、分段
    间隔、种子、并行批大小、采样步数（v3 及之后）、超采样（仅 v3）、辅助参考都已
    接上，进阶项收在「进阶设置」里。
  - 合成记录：输出目录本身就是记录，每条音频旁的同名 `.json` 记文本、角色、参数和
    实际种子；不固定种子时界面先抽一个，「复用参数」可复现。支持 wav / flac、
    试听、在文件夹中显示、重命名、移到回收站（`trash` 库，同 RVC）。
  - 训练页：左栏四步（版本与底模、训练集、训练参数、开始训练），中栏是当前步骤，
    右栏是状态（运行环境、底模、显卡、训练集）和运行日志。训练进行中自动停在第四步。

以下从 RVC-Fabric 沿用（只读复制后改造，不回写）：

- **设计令牌**（app/src/index.css）：Schale 浅蓝体系、`--accent #1289f0`、明暗双主题
  （data-theme + prefers-color-scheme）、14/8px 圆角、玻璃拟态 --glass、原生控件
  color-scheme 联动、换页缓动 --ease-nav。令牌注释文化一并保留。
- **组件语言**：controls.tsx / ui.tsx / SegmentControl / Tooltip / TitleBar / Dock /
  PageHost 全套复用。
- **说明页模式**（HelpPage.tsx）：锚点 Block 手风琴（HELP_ANCHORS 深链）、首次运行
  FAQ、功能分指南（合成/训练/角色包安装）、术语表 glossary、动态个性化内容
  （RVC 版检测用户声卡画接线图；GSV 版对应=按显存/显卡推荐版本与默认参数）、
  DonateNote。内容全部按 GPT-SoVITS 重写。
- **引导体系**：SetupGuide 新手引导、Nudge 提醒、FindingList 自检发现、
  TuningWizard 调校向导思想 → 改造为合成/训练调优向导。
