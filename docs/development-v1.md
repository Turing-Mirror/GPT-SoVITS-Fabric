# Windows 开发 v1

## 环境

安装 Node.js 20 或更新版本、Rust MSVC 工具链、Visual Studio 的 C++ 桌面开发组件及 WebView2。
在 Visual Studio 的 Developer PowerShell 中执行以下命令。不要把某台机器的 Visual Studio 安装路径或共享 Cargo 产物目录写入项目配置。

开发产品根由仓库根目录下的 `scripts/dev_root.py` 组装，包含运行环境、引擎和用户数据。已有的 `data/dev-root` 可以继续使用。模型与运行环境的准备方式见根目录 README。

## 构建并启动

从仓库根目录进入 `app`，安装锁定的前端依赖，再构建页面：

```powershell
Set-Location app
npm ci
npm run build
```

依赖已安装且锁文件未变时可省略 `npm ci`。前端检查或构建失败时，先处理错误再继续。

关闭该开发目录启动的旧桌面程序和后台 API 实例，以便替换可执行文件。在 `app` 中执行：

```powershell
$productRoot = (Resolve-Path ../data/dev-root).Path
Set-Location src-tauri
cargo build --locked --bins -j 1
```

等待 Cargo 输出 `Finished` 后再启动。默认产物目录为 `app/src-tauri/target/debug`；如果自行设置了 `CARGO_TARGET_DIR`，以下路径应使用对应产物目录。

```powershell
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $productRoot
```

原生窗口使用可执行文件旁的 `frontend`，因此只启动 Vite 或只重建前端不足以更新正在运行的桌面程序。修改 Rust 后必须退出旧进程，再启动新产物。`--headless` 用于后台 API，不用于查看界面。

## 依赖编译失败

`E0463: can't find crate` 表示编译器未能加载依赖，不足以证明需要修改 `Cargo.toml`。先保留完整错误信息，并确认使用锁文件和正确的 MSVC 开发环境。

2026 年 11 月 7 日本地构建先后出现 `zerofrom`、`tokio` 的 E0463。详细日志同时报告多项缓存的源码路径已改变。改为单任务构建后，这些依赖通过，但随后捕获到 `schemars_derive` 过程宏 DLL 的 `LoadLibraryExW` 错误，Windows 返回文件被占用（错误码 32）。该 DLL 恢复可加载后可继续构建。现有证据尚不能确定占用文件的进程，也不能证明两类错误具有相同原因。

遇到文件占用时，先结束相关构建并确认文件恢复可用，再重试 `cargo build --locked --bins -j 1`。不要修改依赖版本来绕过文件锁。保留日志在已忽略的 `data/` 下；不要清除包含用户数据的整个开发目录。

本次恢复验证：`npm run build` 和 `cargo build --locked --bins -j 1` 均通过；新编译的桌面程序成功挂载页面，窗口可见且有响应，首页读取到了现有角色与合成记录。此次恢复未修改 Rust 源码或依赖锁文件。

参考：[Rust E0463](https://doc.rust-lang.org/error_codes/E0463.html)、[Cargo 构建选项](https://doc.rust-lang.org/cargo/commands/cargo-build.html)。

## 引擎资源就绪检查

2026-11-07 开发目录的五组底模已安装完整，但程序将 `s1v3.ckpt` 和 `s2Dv2ProPlus.pth` 误判为缺失。原检测要求两者至少 200,000,000 字节；公开发布包中的完整文件实际分别为 155,284,856 与 126,432,639 字节。SoVITS 生成器与判别器不能共用这个下限。

修复将 GPT 与判别器的最小合理体积设为 100,000,000 字节，生成器保留原下限。此处是快速就绪判断；下载完整性仍由发布包 SHA-256 校验负责。增加以真实发布文件长度为样本的回归，同时验证截断文件仍被判定为缺失。

本次五个本地资源包的 SHA-256 与最新公开清单一致，开发目录中的全部包内文件逐一比对一致。修复前通过真实程序的 `assets_status` 重现两项误报，RVCF 同一接口已报告就绪。资源模块 12 项测试通过，重编译并重启后再次读取实际程序状态，确认 GSVF 的缺失列表为空、引擎资源就绪。

## 品牌素材

SVG 原稿位于 `app/src/assets/brand/`：`gsvf-main-logo.svg` 用于标题栏，旁边仅显示产品名称 `GPT-SoVITS Fabric`，不附带副标题；`gsvf-main-icon.svg` 用于应用与网页图标。原稿保留透明背景和原始配色。首页横幅右侧复用 Logo，沿用 RVCF 的淡色展示和窄窗缩放；为文字预留独立空间，720px 以下隐藏装饰标志。

修改 Icon 后，在 `app` 下执行 `npm run brand:icons`。脚本通过 Tauri CLI 生成桌面 PNG、ICO 和 ICNS，并保留已有的 64px 与 256px 文件名。临时产物写入已忽略的 `data/brand-icons/`，无需提交移动端图标。可在命令末尾通过 `-- <SVG 路径>` 指定其他源文件。

提交 SVG 和 `app/src-tauri/icons/` 的生成产物。窗口、托盘和安装器共用此图标集，安装器直接使用 `icons/icon.ico`。图标嵌入原生程序，更新后须重新编译 Rust 并重启；仅替换前端不足以更新系统图标。

生成工具：[Tauri 应用图标](https://v2.tauri.app/develop/icons/)。

## 设置页滚动修复

2026-11-07：`CatalogTransition` 用自然高度的 `QueueList` 承载分类内容，实际滚动归外层 `PageHost`。QueueList 默认的 `overscroll-behavior: contain` 将鼠标滚轮留在自身，即使其内容没有溢出，也阻断外层页面滚动。修复仅对产品的 `.catalog-transition` 设置 `overscroll-behavior: auto`，保留队列组件原有的独立滚动规则和左右切换动画。

复查时将指针放在设置卡片正文上，验证滚轮上下、连续小幅滚动、滚至末项、分类切换后滚动，以及离开设置再返回。覆盖默认和最小窗口尺寸，并在父组件持续刷新时确认滚动位置不复位。不要只检查 `scrollHeight` 或程序设置 `scrollTop`，这两者不能证明真实滚轮事件可以传给外层页面。

## 运行环境与首次安装

新安装的 CPU 与 NVIDIA 环境分别位于 User_Data/runtimes/cpu 和 User_Data/runtimes/nvidia，使用与 RVC Fabric 一致的目录结构。既有 Runtime 仍可识别和使用。在「其他 → 运行环境 → 管理」选择已安装环境可直接切换。新环境先解压并检查完整性，再写入当前选择。首次运行引导在运行环境可用后提示安装引擎基础资源，支持稍后下载和完成退出。

## Community preview

Set these environment variables before launching the desktop program for an isolated test.

| Variable | Value |
| --- | --- |
| TRM_COMMUNITY_API_URL | The Community API base, including /v1/community. |
| TRM_COMMUNITY_WEB_URL | The Community website base. Publish opens the model editor with GPT-SoVITS selected. |
| TRM_ACCOUNT_URL | The Account site base. Use the test Account site for local sign-in. |
| TRM_ACCOUNT_CLIENT_ID | The registered desktop client ID when the test site uses a different one. |

With a Community API configured, the character section reads that catalog. The page still shows app announcements, runtime resources, and release notes. Without a configured API, the existing character feed remains available. The new header puts Publish and Sign in before Refresh. The account name replaces Sign in after authorization.

Guests can download a public character pack. Community packs use the existing staging and installation controls. Updates install a separate copy so the current character and its settings stay available.
