# GPT-SoVITS Fabric 发版

整体流程和两款 Fabric 共用的地址见官网仓库 `docs/fabric-release-v1.md`。本文写 GPT-SoVITS Fabric 的具体操作。

## 1. 准备版本

运行 `python scripts/shell_version.py --set X.Y.Z` 同步版本号。在 `docs/releases/X.Y.Z.md` 写用户能看到的变化，每行一条。推送 `main`。

## 2. 构建安装包

打开 [Build GPT-SoVITS Fabric](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric/actions/workflows/windows-release.yml)，点 **Run workflow**，选择 `main`，勾选 **Prepare release**。Actions 签名并验证后，在 [Releases](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric/releases) 生成本版草稿，附件为 `GPT-SoVITS-Fabric-Setup-X.Y.Z.exe` 和同名的 `.sig`、`.sha256`。

## 3. 公开 GitHub Release

把 `docs/releases/X.Y.Z.md` 的内容填入草稿说明，点 **Publish release**。

## 4. 发布到 CNB

在源码根目录运行：

```powershell
python scripts/cnb_release.py --publish
```

版本号默认读取 `app/package.json`，也可以用 `--version` 指定。脚本读取 GitHub 上已公开的 Release 并核对签名，把同一份 Setup 以版本化文件名和固定文件名 `GPT-SoVITS-Fabric-Setup.exe` 上传到 CNB 的 `GSV-setup` 标签，再更新 `catalog/sources.json`、校验文件、`changelog.json`、`updater.json`，编译 `index.json` 并推送 CNB 发布仓。省略 `--publish` 只在临时目录演练。

CNB 令牌需要 `repo-release:rw` 权限。脚本先读 `CNB_TOKEN`，这台电脑也可沿用 `~/.cnb/agent-token`。

## 5. 同步官网

在官网仓库运行 `npm run sync:releases -- gpt-sovits-fabric X.Y.Z`，构建后推送 `main`，Cloudflare Pages 自动部署。部署完成后确认 `https://www.turingmirror.com/releases/gpt-sovits-fabric/updater.json` 是新版本。
