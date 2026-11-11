# 广场 v1

广场对照 RVC Fabric Neptune `3c4a6d6` 的实现整理，保留社区角色、公告、模型资源和更新日志的顺序，不增加新的一级导航。

## 界面

- 角色卡片、分类下拉框、分页和提示使用新版 RVC Fabric 的实现；系列、作者与译名来自清单，移除客户端内置角色译名表。
- 多作者角色可以选择作者主页。公告无图片时不显示空白图片块。
- 公共角色清单为空时只展示简短空状态，不显示无效筛选器和第三方提示。筛选无结果与网络请求失败分别展示。
- 资源名称补齐八种语言；资源分类根据清单生成，V5 使用合成底模分类，空分类不显示。
- 缩短资源用途说明，移除文件路径堆叠与固定空白高度。

## 下载与导航

角色下载队列和附加资源下载状态位于独立模块，离开广场不会丢失排队、进度或结果。角色包继续使用原有并发上限；GSV 附加资源遵守原生后端的单任务限制。重试清除上一轮进度。安装结果会刷新角色清单和资源状态。

页面刷新同时更新角色、公告、日志和模型资源。从更新日志二级页进入下载区时先返回广场，再滚动到指定分类；减少动态效果设置同样生效。

## 验证

- 前端 61 项测试通过；构建、类型、lint 和八语言文案检查通过。
- Rust 276 项通过，1 项既有桌面窗口测试跳过。
- 浏览器使用真实公开资源清单内容与模拟原生接口，检查八语言 × 两窗口尺寸，没有横向溢出。
- 已验证 V5 分类、资源下载切页恢复、角色下载排队切页恢复及后续启动、更新日志返回下载区。
- 本次界面验证不重复下载大型模型，不进行真实训练。

截图和界面检查输出位于被忽略的 `data/ui-qa/`，不提交模型、缓存或构建产物。

## 公告与资源状态纠正

撤回自行发布的 `resources-v1` 公告。资源上传不构成发布公告或推广内容的授权；没有条目时不渲染投放栏目。

社区角色清单当前为零，界面明确显示尚未发布角色包。基础模型区域展示原生安装清单中的五个包及各自体积；已安装只表示本机状态，不表示线上没有文件。

2026-11-07 使用 CNB CLI 重新核对登录和 Release：`GSV-engine-core` 有八个公开附件，`GSV-runtime` 有两个公开附件，总计 8,339,982,256 字节。匿名读取最新清单得到 13 组附加资源和零个角色包；匿名完整下载 `vocoder.pth` 得到 57,761,163 字节，SHA-256 与清单一致。公开公告清单已回读为空。

本次相关 Rust 测试 11 项、前端构建及八语言文案检查通过；浏览器复核基础模型明细、空投放隐藏和原有下载切页流程。模型验证文件保留在被忽略的 `data/download-check-v1/`。

## 未安装引擎时浏览模型

模型清单、分类、翻页和下载不再要求先安装引擎资源。合成及训练仍按实际使用检查依赖。基础模型名称与体积使用各语言的冒号格式，移除固定的“约 720 MB”。公开清单中原属“其他”的唯一条目为 V5 底模，现明确标记为 `synth`，显示为“合成底模”。

新增未安装引擎状态下的组件测试，验证列表可见、下载按钮可用且直接启动所选模型下载。浏览器复核八语言、两种窗口尺寸与下载切页恢复。

本次原生资源模块 18 项测试通过；前端共 61 项测试通过，构建、类型检查与八语言文案检查通过。

## 旧版底模下载

广场在“引擎资源”下列出基础组件与各版本底模，包括 GPT-SoVITS v3 和 v4。v3 包含 SoVITS 权重和 BigVGAN 的配置及权重。v4 包含 SoVITS 权重和 v4 声码器。两组共用引擎资源中已有的 GPT s1v3。各文件沿用上游路径，v4 与 v5 的同名声码器按不同 Release 标签发布。

角色卡片左上角显示发布日期，左下角用同样样式显示清单登记的底模版本。无法确认底模版本时省略左下角角标。文件体积直接显示，作者主页与来源仓库收在下载旁的更多菜单。

对照固定上游版本表和公开附件，v2、v3、v4、v2ProPlus、v5dev 和 v5turbo 所需底模已有对应资源。v1 的 GPT 与 SoVITS 底模、v2Pro 的 SoVITS G/D，以及 v3 可选的 AP-BWE 超采样权重仍无广场下载项。现有 v1 和 v2Pro 成品角色可用各自随包权重。v2Pro 合成所需的声纹模型随基础引擎资源提供。

上游参考：[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/README.md)、[预训练模型](https://huggingface.co/lj1995/GPT-SoVITS/tree/main)。

隔离客户端从公开广场下载五个文件并校验哈希，两组均显示已安装。使用下载所得权重完成真实 CUDA 短句合成，v3 输出 24 kHz，v4 输出 48 kHz。训练页 v4 底模缺失列表为空。前端 107 项测试和完整构建通过。

原训练与合成分类共用引擎资源页签，旧的训练入口仍可直接跳到这里。基础组件集中安装，各版本底模按需选择。人声分离保留独立页签。

## Community publishing

Open Publish from Community to choose a character ZIP from a public repository. Select the base model version used by the package, add an author page if you have one, and crop a cover. A detected license fills the form and can be edited. Sign in with a TRM Account to submit for review. My submissions shows local drafts and paginated review history.

Community keeps the current search, filters, department page, and scroll position when you switch tabs. Departments display eight at a time. Catalog filters and pagination use the shared TRM UI slide.
