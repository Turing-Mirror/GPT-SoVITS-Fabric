# GPT-SoVITS Fabric

**开箱即用的 GPT-SoVITS 桌面客户端**

基于 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 深度定制 · 由 [图灵镜 Turing Mirror](https://github.com/Turing-Mirror) 开发维护

[GitHub 仓库](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [CNB 制品下载](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**社媒**　[哔哩哔哩 @图灵镜](https://space.bilibili.com/3546871148579062)　·　[抖音 @图灵镜](https://v.douyin.com/6NxXcrKK9cc)（抖音号 `TuringMirror`）　·　[小红书 @图灵镜](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094)（小红书号 `TuringMirror`）　·　QQ 群 @图灵镜社区（群号 `1077458748`）

---

## 简介

GPT-SoVITS Fabric 是面向 Windows 的语音合成桌面软件。无需自行安装 Python 或 PyTorch，也无需打开浏览器页面，安装后即可合成与训练。

## 功能

- **合成**：选择角色与参考音频，输入文本即可合成，支持流式输出。
- **训练**：用自己的音频与标注训练角色，完成后自动加入角色库。
- **标注**：校对 `.list` 标注文件，同一份标注可用于合成参考与训练。
- **人声分离**：从歌曲或视频音频中提取人声，用作训练素材。
- **广场**：下载角色包、底模与分离模型。

## 快速开始

1. 运行安装包，首次启动时按提示下载运行环境（NVIDIA 显卡选 CUDA 版，其余选 CPU 版）。
2. 下载引擎资源（合成与训练所需的基础模型，约 2.1 GB）。
3. 在「广场」安装一个角色包，或在「训练」中创建自己的角色。
4. 在「合成」中选择角色与参考音频，输入文本后开始合成。参考音频须为 3–10 秒。

## 开源许可与免责声明

- 本项目源码采用 [MIT License](./LICENSE) 许可协议开源。
- 模型权重、角色包及第三方资源遵循其原始许可协议。
- **免责声明**：请勿将本软件用于伪造身份、欺诈或其他违法用途。使用他人声音进行训练或合成前，请取得原权利人授权。使用者应遵守当地法律法规。

## 致谢

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — 核心模型与上游基础
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — 人声分离引擎与模型来源
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) — 音频处理
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — 桌面端架构与界面来源
