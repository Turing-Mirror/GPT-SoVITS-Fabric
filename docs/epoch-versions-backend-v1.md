# GSV 训练轮次版本后端 v1

日期：2026-11-25。任务卡：`F:\Dev\Turing-Mirror\docs\codex\epoch-versions-backend.md`。

本报告对应 GSV 仓库 `F:\Dev\Turing-Mirror\GPT-SoVITS-Fabric`，起始分支为 `main`，起始提交为 `dcee565`。未提交、未推送、未切换分支、未 stash。原有未跟踪目录 `.wrangler/` 未处理。未修改 RVC 仓库。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `app/src-tauri/src/model_versions.rs` | 新增轮次枚举、完整实验名匹配、SHA-256 缓存、当前状态判定、切换入口与单元测试；供清理复用候选枚举。 |
| `app/src-tauri/src/lib.rs` | 注册两个异步 Tauri 命令，切换成功后发送现有 `roles-changed` 事件。 |
| `app/src-tauri/src/role_assets.rs` | 扩展既有替换事务，在同一配置写入与回滚流程中记录选中轮次；普通更换文件清除该种类的选中记录。 |
| `app/src-tauri/src/train.rs` | 新增默认开启的 `save_every_weights`，传入日志与 worker 请求；解析默认权重目录；增加 `snapshots` 清理类别。 |
| `app/src-tauri/src/train_queue.rs` | 更新请求夹具，验证旧队列默认开启，以及显式关闭值在序列化后保留。 |
| `app/src-tauri/src/characters.rs` | 导出副本的配置去掉 `training`；扩展导出测试，确认本地配置保留原值。 |
| `app/src-tauri/engine-payload/tools/train_worker.py` | 保存开关贯通两阶段；仅按本次训练开始后的修改时间收集精确匹配的权重；合并角色配置，保留作者、封面、显示名、已有标注及其他字段；记录训练来源与最终轮次。 |
| `app/src-tauri/engine-payload/GPT_SoVITS/s2_train.py` | 全参 SoVITS 在最终轮保存存档并导出推理权重，不受中途保存开关和间隔整除限制。 |
| `app/src-tauri/engine-payload/GPT_SoVITS/s2_train_v3_lora.py` | 对 LoRA 训练应用相同的最终轮导出条件。 |
| `app/src-tauri/engine-payload/GPT_SoVITS/s1_train.py` | GPT 回调在最终轮导出推理权重，不受中途保存开关和间隔整除限制。 |
| `scripts/prepare_engine_payload.py` | 同步上游后重新应用最终轮导出修补，避免重新准备负载时覆盖修补。 |
| `scripts/test_epoch_versions.py` | 新增 worker 收集、默认值、阶段配置及实际保存代码分支测试。 |
| `app/src/lib/modelVersions.ts` | 新增共享返回类型及两个 invoke 封装。 |
| `app/src/pages/TrainPage.tsx` | 仅在入队请求中增加 `save_every_weights: true`；未增加控件或调整布局。 |
| `docs/epoch-versions-backend-v1.md` | 本报告。 |

新增源文件和本报告均未被 `.gitignore` 忽略。构建产物 `app/src-tauri/target/export/` 与测试日志 `data/epoch-versions-v1/` 被现有规则忽略。未修改依赖或锁文件。

## 行为

新训练角色写入 `training.experiment`、绝对路径 `training.weights_dir` 和 `training.final.{sovits,gpt}`。收集按新鲜文件的修改时间选择，不按最大轮数选择；任一阶段未留下本次权重时返回已有的 `train.no_weight`。

旧角色依次读取配置中的明确实验名字段。旧 worker 写出的 `source: "trained"` 角色还可从 `name` 恢复原实验名；其余回退角色目录名。只按完整实验名匹配，不使用前缀或子串匹配。

当前 worker 把 SoVITS 的 `save_weight_dir` 与 GPT 的 `train.half_weights_save_dir` 显式设为同一个请求输出目录，因此当前两种权重共用扫描目录。未配置输出目录时使用 `User_Data/train/<实验名>/weights`。已记录的训练来源优先于后来更改的全局输出设置。

枚举只接受 `<exp>_e<N>_s<M>.pth`、`<exp>_e<N>_s<M>_l<R>.pth` 和 `<exp>-e<N>.ckpt`，按轮次、步数、文件名升序排列。训练存档不列入候选。`is_final` 取自已记录的最终源文件名。

当前状态按安装副本与候选的实际内容判断：先比较大小，再比较 SHA-256；缓存按路径、大小及修改时间复用。支持 `matched`、`source_removed`、`external`、`missing`。多个候选内容相同时优先标记已记录的选中文件。

切换重新解析已安装角色、重新枚举候选，拒绝路径形式的 target、越界目录和非候选文件。复用既有暂存、配对检查、`while_idle`、推理 worker 关闭及配置失败回滚。`training.selected.<kind>.sha256` 来自实际通过验证的暂存文件。普通更换文件仅删除对应种类的 `selected`，不删除另一个种类的记录。

`snapshots` 清理与枚举使用相同匹配规则，覆盖当前默认位置及角色记录的历史输出目录；仅删除源权重，保留角色安装副本、其他实验、训练存档和日志。角色包导出只从导出用配置中移除 `training`，本地配置保留。

## 命令与真实测试返回

`model_versions_list({ target })` 返回 `ModelVersions`；`model_version_apply({ target, kind, file })` 返回切换后的相同结构。GSV 接受的种类是 `sovits` 和 `gpt`，`target` 是已安装角色 ID。

前端调用为 `listModelVersions(target)` 与 `applyModelVersion(target, kind, file)`。共享 TypeScript 种类联合包含 `rvc`；GSV 后端拒绝该种类。

以下 JSON 来自测试 `model_versions::tests::apply_records_the_validated_bytes_and_external_replacement_clears_only_its_kind` 的实际输出。夹具创建了临时角色及两组权重文件，调用同一后端实现；检查点内容检查器在此用例中替换为成功夹具。路径是该次测试的真实临时路径，测试结束后已删除。

列举请求：

```json
{"target":"voice"}
```

`model_versions_list` 返回：

```json
{
  "experiment": "Voice.[a]+(1)",
  "weights_dir": "C:\\Users\\Ka251\\AppData\\Local\\Temp\\trm-t-versions-apply-26556-0\\User_Data\\train\\Voice.[a]+(1)\\weights",
  "weights": [
    {
      "kind": "sovits",
      "current": {
        "state": "matched",
        "file": "Voice.[a]+(1)_e5_s50_l32.pth",
        "epoch": 5,
        "step": 50
      },
      "versions": [
        {
          "file": "Voice.[a]+(1)_e2_s20.pth",
          "epoch": 2,
          "step": 20,
          "is_final": false,
          "current": false
        },
        {
          "file": "Voice.[a]+(1)_e5_s50_l32.pth",
          "epoch": 5,
          "step": 50,
          "is_final": true,
          "current": true
        }
      ]
    },
    {
      "kind": "gpt",
      "current": {
        "state": "matched",
        "file": "Voice.[a]+(1)-e5.ckpt",
        "epoch": 5,
        "step": null
      },
      "versions": [
        {
          "file": "Voice.[a]+(1)-e2.ckpt",
          "epoch": 2,
          "step": null,
          "is_final": false,
          "current": false
        },
        {
          "file": "Voice.[a]+(1)-e5.ckpt",
          "epoch": 5,
          "step": null,
          "is_final": true,
          "current": true
        }
      ]
    }
  ]
}
```

切换请求：

```json
{"target":"voice","kind":"gpt","file":"Voice.[a]+(1)-e2.ckpt"}
```

`model_version_apply` 返回：

```json
{
  "experiment": "Voice.[a]+(1)",
  "weights_dir": "C:\\Users\\Ka251\\AppData\\Local\\Temp\\trm-t-versions-apply-26556-0\\User_Data\\train\\Voice.[a]+(1)\\weights",
  "weights": [
    {
      "kind": "sovits",
      "current": {
        "state": "matched",
        "file": "Voice.[a]+(1)_e5_s50_l32.pth",
        "epoch": 5,
        "step": 50
      },
      "versions": [
        {
          "file": "Voice.[a]+(1)_e2_s20.pth",
          "epoch": 2,
          "step": 20,
          "is_final": false,
          "current": false
        },
        {
          "file": "Voice.[a]+(1)_e5_s50_l32.pth",
          "epoch": 5,
          "step": 50,
          "is_final": true,
          "current": true
        }
      ]
    },
    {
      "kind": "gpt",
      "current": {
        "state": "matched",
        "file": "Voice.[a]+(1)-e2.ckpt",
        "epoch": 2,
        "step": null
      },
      "versions": [
        {
          "file": "Voice.[a]+(1)-e2.ckpt",
          "epoch": 2,
          "step": null,
          "is_final": false,
          "current": true
        },
        {
          "file": "Voice.[a]+(1)-e5.ckpt",
          "epoch": 5,
          "step": null,
          "is_final": true,
          "current": false
        }
      ]
    }
  ]
}
```

该用例还断言选中记录包含源文件名、epoch、step 和与实际安装文件一致的 SHA-256，并验证外部更换仅清除 GPT 记录，保留 SoVITS 记录和角色其他元数据。

## i18n

新增 i18n 键：无。未修改任何文案文件。角色、权重类型、无效权重、运行环境和忙状态错误复用现有翻译键。

`StorageSection.tsx` 已有 `snapshots` 映射及 `s.cleanupSnapshots`，无需改组件或增加类别键。现有 `s.cleanupEffectNone` 为“删除后无影响”，需由文案维护者更新，以说明删除后保留已装模型，但不能再切回被删轮次；本次未修改该键。

## 测试

所有命令在本仓库执行；原生日志位于 `data/epoch-versions-v1/`。Rust 测试加载本机 MSVC 开发环境，设置 `CARGO_BUILD_JOBS=1`，使用任务卡规定的 `CARGO_TARGET_DIR=target/export`。

在 `app/src-tauri` 执行：

```powershell
$env:CARGO_TARGET_DIR = 'target/export'
$env:CARGO_BUILD_JOBS = '1'
cargo test --locked --lib
```

全量测试输出末尾（`cargo-metadata.log`）：

```text
test result: ok. 319 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 40.16s
```

两项忽略测试是既有的真实下载端到端测试 `e2e_download::live_download_chain` 和需要桌面窗口的 `window_watch::windows_tests::tool_frame_from_worker_frame_geometry_and_main_window`；它们未在本轮执行。模拟服务测试在实际进入全量测试后全部通过，没有单独复跑。

新增 Rust 用例覆盖文件名转义与完整匹配、四种当前状态、目标与候选准入、切换记录、外部替换记录清理、失败验证不改文件、旧角色来源、配置目录回退、清理源文件保留安装副本和哈希缓存更新。队列用例验证旧请求默认 true、显式 false 及序列化回读。现有导出用例增加导出配置不含 training、原角色配置不变的断言。

真实 JSON 的单例输出命令：

```powershell
cargo test --locked --lib model_versions::tests::apply_records_the_validated_bytes_and_external_replacement_clears_only_its_kind -- --nocapture
```

`command-examples.log` 末尾：

```text
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 320 filtered out; finished in 0.03s
```

在 `app` 执行 `npm test`，`frontend-tests.log` 末尾：

```text
Test Files  34 passed (34)
      Tests  131 passed (131)
   Start at  02:42:30
   Duration  9.70s (transform 5.11s, setup 0ms, import 7.79s, tests 9.10s, environment 15.94s)
```

同目录执行 `npx tsc --noEmit`，退出码 0，无诊断输出；`typescript.log` 为空。

在仓库根目录执行 `python -B -m unittest scripts.test_epoch_versions scripts.test_annotation_prepare -v`，`python-tests.log` 末尾：

```text
----------------------------------------------------------------------
Ran 13 tests in 1.222s

OK
```

其中 8 项为本次新增用例、5 项为原有标注准备测试；保存代码覆盖开关 true/false、整除与非整除最终轮、非最终轮和 SoVITS 非主进程。

在仓库根目录执行 `data/dev-root/Runtime/python.exe -B scripts/test_weight_inspect.py -v`，`weight-inspect-runtime.log` 末尾：

```text
----------------------------------------------------------------------
Ran 15 tests in 2.136s

OK
```

`git diff --check` 通过，无输出。

测试环境重试记录：首次 Rust 构建报 `zerovec` 的 E0463；加载 MSVC 后报 `icu_normalizer`、`icu_properties`，重建相关依赖后报 `time`。继续重建 time 相关缓存并启用 `RUSTC_LOG=rustc_metadata::locator=info` 后，全量测试通过；未更改依赖版本或锁文件。日志分别保留在首次日志、`cargo-test.log`、`cargo-retry.log`、`cargo-metadata.log`。未进一步确定 E0463 的根因。系统 Python 首次运行权重检查测试因未安装 torch 而导入失败（`weight-inspect-test.log`），改用应用已有 Runtime 后 15 项通过。

## 与任务卡的差异及验证范围

任务卡总规则要求不改页面组件，第七节明确允许训练请求加字段。本次仅按该例外在 `TrainPage.tsx` 增加一个请求字段，没有新增开关或调整页面。

最终轮导出修补位于随包的三个训练脚本，并由负载准备脚本重新应用；worker 负责保存开关和收集时间边界。原因是最后一轮未命中保存间隔时，worker 事后无法从旧训练存档恢复最后一轮的内存参数。未升级上游版本。核对依据为本仓库固定版本源码，以及当日读取的上游 [GPT 保存回调](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/GPT_SoVITS/s1_train.py) 和 [SoVITS 保存条件](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/GPT_SoVITS/s2_train.py)。

Python 的最终轮测试执行实际训练脚本中提取的保存代码，替代张量、训练器及文件保存器；未执行真实 GPU 训练。Rust 切换夹具替代检查点内容检查器，以验证事务与返回结构；检查点结构及配对由现有 Runtime 测试单独验证。未进行真实语音合成、音质验收或前端页面接入验收。

首次测试命令误将一个编译日志写到了 `F:\Dev\Turing-Mirror\data\epoch-versions-v1\cargo-test.log`（6440 字节），后续日志均在 GSV 仓库内。检查确认父目录下该文件夹仅有这一个生成日志。将其移回 GSV 并删除空目录的操作被自动审批拒绝，理由是路径超出本次仅 GSV 仓库的授权范围；该生成日志仍保留，清理需要单独授权。未在其他仓库修改源文件。
