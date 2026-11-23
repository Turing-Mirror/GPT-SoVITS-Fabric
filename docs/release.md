# GPT-SoVITS Fabric 发版

整体流程和两款 Fabric 共用的地址见官网仓库 `docs/fabric-release-v1.md`。本文写 GPT-SoVITS Fabric 的具体操作。

## 1. 准备版本

运行 `python scripts/shell_version.py --set X.Y.Z` 同步版本号。在 `docs/releases/X.Y.Z.md` 写用户能看到的变化，每行一条。推送 `main`。

## 2. 构建安装包

打开 [Build GPT-SoVITS Fabric](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric/actions/workflows/windows-release.yml)，点 **Run workflow**，选择 `main`，勾选 **Prepare release**。Actions 签名并验证后，在 [Releases](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric/releases) 生成本版草稿，附件为 `GPT-SoVITS-Fabric-Setup-X.Y.Z.exe` 和同名的 `.sig`、`.sha256`。

## 3. 公开 GitHub Release

把 `docs/releases/X.Y.Z.md` 的内容填入草稿说明，点 **Publish release**。

## 4. 发布到 Cloudflare

在源码根目录运行：

```powershell
python scripts/cnb_release.py --publish
```

版本号默认读取 `app/package.json`，也可以用 `--version` 指定。脚本读取 GitHub 上已公开的 Release 并核对签名，将版本化安装包和固定名 `GPT-SoVITS-Fabric-Setup.exe` 上传到 Cloudflare R2 的 `trm-releases/gpt-sovits-fabric/`。两份 CDN 下载的 SHA-256 与大小均核对通过后，才删除同前缀中的旧版本化安装包。

清单直接维护于相邻的 `GPT-SoVITS-Fabric-Releases` 本地检出，可用 `--catalog` 指定目录。脚本更新 sources、校验文件、changelog、updater 和 index，使用 `https://cdn.turingmirror.com/f/gpt-sovits-fabric/` 下的版本化安装包地址，只本地提交，不 clone 或 push CNB。省略 `--publish` 在临时副本演练，不修改本地发布仓。发布前本地发布仓须干净。

复用 Wrangler 的 Cloudflare 登录；多个账户时设置 `CLOUDFLARE_ACCOUNT_ID`，需要时以 `TRM_WRANGLER` 指定 CLI。详见官网的 `docs/fabric-release-v1.md`。

## 5. 同步官网

在官网仓库运行 `npm run sync:releases -- gpt-sovits-fabric X.Y.Z`，从本地发布仓同步完整 `index.json`、updater、更新日志和公告图片，构建后推送 `main`，Cloudflare Pages 自动部署。部署完成后确认 `https://www.turingmirror.com/releases/gpt-sovits-fabric/updater.json` 是新版本。
