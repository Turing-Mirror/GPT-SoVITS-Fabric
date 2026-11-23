# 下载链路端到端验收 v1

2026-11-24，Asia/Taipei。按工作区 `docs/codex/e2e-download-check.md` 验证现有 GSV 1.0.4、RVC 1.8.2。

**结论：GSV 官网产品页下载按钮和官网 setup.exe 跳转失败，均指向已返回 404 的 1.0.3 安装包；其余要求通过。** 未修改线上清单、R2、D1、ModelScope、GitHub Release 或官网部署。

## 逐项结果

| 任务项 | 结果 | 证据 |
| --- | --- | --- |
| 一、1：GSV updater 与安装包 | 通过 | 官网版本 1.0.4；完整下载 26,196,311 字节，SHA-256 与 GitHub 校验文件一致，签名脚本通过。 |
| 一、1：RVC updater 与安装包 | 通过 | 官网版本 1.8.2；完整下载 25,122,935 字节，SHA-256 与 GitHub 校验文件一致，签名脚本通过。 |
| 一、2：GSV 短链 | 通过 | 302 到 R2 固定名，完整下载的哈希等于 1.0.4。 |
| 一、2：RVC 短链 | 通过 | 302 到 R2 固定名，完整下载的哈希等于 1.8.2。 |
| 一、3：GSV 产品页按钮 | **失败** | 在线 HTML 的“下载 Windows x64”指向 `GPT-SoVITS-Fabric-Setup-1.0.3.exe`，GET 返回 404。 |
| 一、3：GSV 官网 setup.exe | **失败** | 302 到同一个 1.0.3 文件，最终 GET 返回 404。 |
| 一、3：RVC 产品页按钮 | 通过 | “下载 Windows 版 .exe”指向短链，最终 Range GET 返回 206 和正确安装包前缀。 |
| 一、3：RVC 官网 setup.exe | 通过 | 302 到短链，再 302 到 R2 固定名，最终返回 206。 |
| 一、4：GSV 1.0.3 更新检查模拟 | 通过 | 从 GitHub `v1.0.3` 的 tauri.conf.json 读取首个 endpoint，返回 1.0.4，版本比较为更新。 |
| 一、4：RVC 1.8.1 更新检查模拟 | 通过 | 从 GitHub `v1.8.1` 的 tauri.conf.json 读取首个 endpoint，返回 1.8.2，版本比较为更新。 |
| 二、1：GSV 实际清单来源 | 通过 | `catalog::fetch_remote_catalog` 的测试日志记录实际命中官网 index.json，版本为 1.0.4。 |
| 二、2：GSV CPU 运行环境 | 通过 | 真实 `download::download_request` 从 ModelScope 完整下载 594,573,268 字节，大小和 SHA-256 均通过。 |
| 二、3：最小底模 | 通过 | 自动选择 `base-langdetect.zip`，从 ModelScope 完整下载 131,266,386 字节并校验。 |
| 二、3：gsv-v5 vocoder | 通过 | `vocoder.pth` 从 ModelScope 完整下载 57,761,163 字节并校验。 |
| 二、4：CNB → ModelScope 回退 | 通过（部分下载） | CNB 返回 403 后自动切到第二个 URL；下载 5,487,367 字节后主动取消，其哈希与已验证完整 CPU 包的同长度前缀一致。 |
| 二、5：清理与默认忽略 | 通过 | 资源、回退片段和安装包均已删除；data/e2e 中大于 1 MiB 的文件为 0；联网测试默认 ignored。 |
| 三：RVC NVIDIA | 通过 | 真实客户端解析 CNB index；Range 返回 `206 bytes 0-1023/6077133824`，读到 1024 字节。 |
| 三：RVC NVIDIA 50 | 通过 | Range 返回 `206 bytes 0-1023/6698774016`，读到 1024 字节。 |
| 三：RVC AMD | 通过 | Range 返回 `206 bytes 0-1023/1801268224`，读到 1024 字节。 |

完整结构化结果见 [e2e-download-check-v1.json](e2e-download-check-v1.json)，包含初始地址、实际跳转、最终地址、哈希、大小和失败原文。

安装包采用 GET 跟随跳转后分片读取全部字节，再计算完整哈希。按钮和 setup.exe 使用 Range GET 验证，固定名的完整文件已由对应短链下载校验。旧版检查为 endpoint 与版本比较模拟，未实际安装或启动旧版桌面程序。RVC 运行环境仅验证解析与 Range，不宣称完整包校验或 ModelScope 上传完成。

## 官网入口失败原始输出

```text
python GPT-SoVITS-Fabric/data/e2e_release_check.py
RESULT {"item": "gpt-sovits-fabric/button:下载 Windows x64", "pass": false, "url": "https://cdn.turingmirror.com/f/gpt-sovits-fabric/GPT-SoVITS-Fabric-Setup-1.0.3.exe", "error": "<HTTPError 404: 'Not Found'>"}
RESULT {"item": "gpt-sovits-fabric/button:setup.exe", "pass": false, "url": "https://www.turingmirror.com/releases/gpt-sovits-fabric/setup.exe", "error": "<HTTPError 404: 'Not Found'>"}
SUMMARY 10 passed 2 failed
```

独立 curl GET 复核命令：

```powershell
curl.exe -sS -L -D - --range 0-1023 --max-time 45 -o NUL -w 'FINAL %{url_effective} HTTP %{http_code}\n' 'https://www.turingmirror.com/releases/gpt-sovits-fabric/setup.exe'
```

原始状态、Location 和末行摘录：

```text
HTTP/1.1 302 Found
Location: https://cdn.turingmirror.com/f/gpt-sovits-fabric/GPT-SoVITS-Fabric-Setup-1.0.3.exe
HTTP/1.1 404 Not Found
FINAL https://cdn.turingmirror.com/f/gpt-sovits-fabric/GPT-SoVITS-Fabric-Setup-1.0.3.exe HTTP 404
```

按卡保留失败，没有修复线上或本地官网内容。

## 安装包与更新

官网签名均与 GitHub Release 的 .sig 一致。验证命令为 `node <产品仓>/scripts/verify_setup_signature.mjs <安装包> <产品仓>/app/src-tauri/tauri.conf.json`。GSV 原始输出为 `Updater signature and installer SHA-256 verified.`；RVC JSON 输出的 `signature_verified` 为 true。

| 产品 | 版本化文件与短链最终文件的 SHA-256 |
| --- | --- |
| GSV 1.0.4 | `771f164d3db31009b4f86908629f74ffc389366eb24b73bb1ee74d8908b06e43` |
| RVC 1.8.2 | `6a20f255d11c56d1882e9c74931ac52e51fe2cbc6282688f4b65056fda675c16` |

旧版配置通过 `gh api 'repos/Turing-Mirror/<产品>/contents/app/src-tauri/tauri.conf.json?ref=v<旧版本>' -H 'Accept: application/vnd.github.raw+json'` 读取；两个首选 endpoint 分别为官网 `/releases/gpt-sovits-fabric/updater.json`、`/releases/rvc-fabric/updater.json`。读取后分别得到 `1.0.3 → 1.0.4`、`1.8.1 → 1.8.2`。

## 真实客户端测试

在对应产品的 `app/src-tauri`，使用 Visual Studio Developer PowerShell：

```text
cargo test --locked --lib e2e_download::live_download_chain -- --ignored --nocapture
[gsv-fabric] catalog source https://www.turingmirror.com/releases/gpt-sovits-fabric/index.json
test e2e_download::live_download_chain ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 311 filtered out; finished in 115.00s

cargo test --locked --test e2e_runtime -- --ignored --nocapture
CATALOG https://cnb.cool/Turing-Mirror/RVC-Fabric-Releases/-/git/raw/main/index.json version="1.8.2"
test live_runtime_ranges ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.45s
```

GSV 三份资源实际使用 ModelScope revision `ba30c8ae2d8a533926d664f1691e3b757a6c3902`：

| 资源 | SHA-256 |
| --- | --- |
| CPU runtime | `30910118ba208dc6ef599dca060d99bea44f55fc32665b0ed9f53ac816cc989f` |
| base-langdetect.zip | `a0fe2fbfb0decf18bd03b599e6ed3fb59060a2eca9fe2225d482cf768f164543` |
| gsv-v5/vocoder.pth | `b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f` |

回退日志原文：

```text
2026-11-24 02:02:39.392 download runtime try https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases/-/releases/download/GSV-runtime/runtime-cpu-2026.10.31.tar.gz (attempt 1, conns 1)
2026-11-24 02:02:39.507 download runtime fail https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases/-/releases/download/GSV-runtime/runtime-cpu-2026.10.31.tar.gz: resume: status 403
2026-11-24 02:02:39.509 download runtime try https://modelscope.cn/models/Kara251/kara-gsv-model/resolve/ba30c8ae2d8a533926d664f1691e3b757a6c3902/fabric/runtime/runtime-cpu-2026.10.31.tar.gz (attempt 1, conns 1)
FALLBACK outcome=Err("已取消")
```

回退仅验证前缀，不宣称再次完成整个包校验；前缀哈希为 `ced260f4d669a0119fa630408477b914949c6c76489a0dbac622e07819febee9`。

## 常规测试与清理

```text
GSV: cargo test --locked --lib -j 1
test result: ok. 310 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 40.17s

RVC: cargo test --locked --test e2e_runtime
test live_runtime_ranges ... ignored, Live CNB requests; explicit acceptance only
test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

Removed 4 installer files, 102638492 bytes
Remaining files larger than 1 MiB in data/e2e: 0
```

保留 GSV `app/src-tauri/tests/support/e2e_download.rs`、RVC `app/src-tauri/tests/e2e_runtime.rs`。GSV 的 lib.rs 仅在 cfg(test) 下加载测试，catalog.rs 仅在 cfg(test) 下记录命中地址；发布构建不包含这些测试语句。两个联网测试均为 ignored。

原始日志保留于 GSV `data/e2e-release.log`、`data/e2e-gsv.log`、`data/e2e-gsv-default-tests.log`、`data/e2e/gsv-30664/`，以及 RVC `TEMP/e2e-rvc.log`、`TEMP/e2e-rvc-default-tests.log`。这些目录已被 .gitignore 忽略，大文件均已删除。两个仓分别提交指定共同作者，不 push。
