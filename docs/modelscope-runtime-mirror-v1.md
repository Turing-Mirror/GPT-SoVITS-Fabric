# ModelScope 下载镜像 v1

发布仓可在 `catalog/sources.json` 旁提供 `catalog/modelscope.json`：

```json
{
  "repo": "Kara251/kara-gsv-model",
  "files": {
    "<小写 SHA-256>": "https://modelscope.cn/models/Kara251/kara-gsv-model/resolve/<commit>/<path>"
  }
}
```

`scripts/build_catalog.py` 在编译时读取该文件。文件不存在时沿用原地址；哈希匹配时，将镜像放到 runtimes、engine_core、extras、gsv-cpp 和 app 的 `urls` 首位，保留 CNB 地址。安装包的 `app.gui.url` 同步使用匹配的镜像，继续沿用浏览器下载流程。

清单入口依次为官网 `https://www.turingmirror.com/releases/gpt-sovits-fabric/index.json` 与原有两条 CNB 地址。编译命令仍为：

```powershell
python scripts/build_catalog.py --sources ../GPT-SoVITS-Fabric-Releases/catalog/sources.json --out ../GPT-SoVITS-Fabric-Releases/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json
```

客户端保留清单 URL 顺序，HTTP 错误、超时或校验失败后尝试下一个地址。已有下载片段不改变镜像优先级；有预期 SHA-256 时可以跨镜像续传，最终校验通过后才落入目标文件。清单中的非零文件大小也参与校验。

底模与 VC++ 安装包优先读取远程清单，再读取本地清单；只有名称和内置 SHA-256 一致的条目可提供镜像和大小。gsv.cpp 与附加模型直接使用各自条目的地址、SHA-256 和大小。VC++ 包可登记在清单的独立条目或 extras 文件列表中。

公开下载客户端不携带账号凭据或 Cookie。它跟随重定向，不按 CNB 路径过滤 ModelScope 或 CDN 地址；参见 [reqwest 重定向说明](https://docs.rs/reqwest/0.12.28/reqwest/redirect/index.html)。

回归测试覆盖映射缺失、所有下载段、旧版单包底模、URL 顺序、403/404/503、首字节超时、跨主机 302、断流续传及 SHA-256/大小不匹配。测试使用临时目录和本机 HTTP 服务，不上传制品、不发布清单，也不代表真实大文件下载验收。

```powershell
python -m pytest scripts
cd app
npx vitest run
cd src-tauri
cargo test --locked -j 1
```
