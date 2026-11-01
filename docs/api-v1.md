# 独立 API v1

Neptune 分支提供独立本机 API 与 MCP。只安装 GPT-SoVITS Fabric 即可使用，不需要账号或其他产品。主程序拥有推理内核和任务；API 与图形界面共用现有 worker。

## 启动和发现

安装器完成安装时登记当前安装，便携版本在首次运行时登记。也可使用 --register-api 只登记，--print-api-manifest 输出完整能力与 JSON Schema，--headless 启动后台服务。开发环境可用 --product-root 指定本软件的数据与运行环境目录。

Windows 登记位于 %APPDATA%/TuringMirror/installed，运行记录位于 apps。多个安装按实例 ID 区分。客户端使用登记的随机回环端口与 Bearer 凭据；不固定端口，也不向网页或前端提供该凭据。该凭据仅供当前系统用户的本机程序使用。

## MCP

软件随包包含 gpt-sovits-fabric-mcp.exe。将它配置为 stdio MCP server：

    {
      "mcpServers": {
        "audio": {
          "command": "C:/Apps/gpt-sovits-fabric/gpt-sovits-fabric-mcp.exe"
        }
      }
    }

开发构建或自定义路径可增加 args: ["--app", "主程序完整路径"]；已登记的多个安装可用 --install 指定实例 ID。bridge 只启动并连接本软件。

tools/list 返回可调用能力、输入 JSON Schema、任务返回格式及最终结果 Schema。app_status、resources_list、jobs_list、job_get、job_cancel 为通用工具。

| MCP 工具 | 用途 |
| --- | --- |
| gsv_characters | 查询真实角色、权重与参考音频 |
| gsv_synthesize | 使用所选角色合成语音 |

gsv_synthesize 接收 roleId、text、referenceAudio、referenceText、referenceLanguage，以及 parameters、format、outputDirectory 等可选参数，具体必填项由 tools/list 的 Schema 给出。先用 gsv_characters 查看已有角色及可用参考资料。

合成复用本软件常驻 Python worker，不默认启动另一套 api_v2.py 进程。原生 GPT-SoVITS HTTP API 可作为参数参考，本 API 提供角色资源、任务、取消与产物查询。

音频操作立即返回 jobId，使用 job_get 读取进度和结果。断开 MCP 不会取消任务。job_cancel 只请求取消指定任务，最终状态通过 job_get 确认。输出位于独立任务目录；完成的 artifacts 包含真实路径、格式、采样率、声道及长度。

## 原始 API

使用 WebSocket JSON-RPC 2.0，方法包括 app.hello、app.manifest、app.status、res.list、res.get、cap.call、job.list、job.get、job.cancel、app.show、app.quit。完整契约见 [trm-app-protocol](https://github.com/Turing-Mirror/trm-app-protocol/blob/main/docs/protocol-v1.md)。

cap.call 接收 capability、arguments，以及可选 clientId/requestId。相同客户端及 requestId 返回已有任务，便于重连。服务器验证输入 Schema，不把参数错误包装成已成功的任务。进程中断后，未完成任务记录为 interrupted，不伪造推理断点续跑。

运行依赖和模型沿用本软件现有安装流程。API 不自行下载模型，不代替用户选择音色。未安装运行环境或指定资源不存在时返回实际错误。

## 界面适配

Manifest 同时发布原前端入口和通用 Host 协议，供原生容器加载软件实际页面。UI 命令桥接不作为 Agent 的任意执行工具暴露。托管适配仍在 Neptune 验证；普通独立窗口和 API 可分别使用。

## 开发验证

从 app 运行 npm ci、npm run build，再在 app/src-tauri 运行 cargo build --bins -j 1。Tauri 根据 Cargo 的 bin 列表打包主程序及 MCP。没有增加正式版的账号入口。

可使用协议仓库的 examples/mcp-smoke.mjs 验证初始化、能力列表、真实资源及任务查询。音频验收需要本机运行环境和模型；构建通过不代替实际音频试听。
