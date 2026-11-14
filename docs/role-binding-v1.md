# 角色绑定 v1

日期：2026-11-07。

## 模型与标注

模型页每张角色卡片底部并列“合成”“标注”和“⋯”三个按钮。“合成”打开该角色的合成页；“标注”管理关联标注及模型权重；“⋯”包含资料、封面、导出、文件夹和删除操作。卡片本身不响应左键或键盘激活，也不提供右键菜单；操作仅由底部按钮触发，封面上不再叠放菜单按钮。

- “更换文件”替换当前角色的 GPT 或 SoVITS 权重。更换 SoVITS 后由检查点内容自动识别版本，不再手动填写版本。替换前检查权重结构及 GPT/SoVITS 配对，验证失败保留原文件。
- “关联 .list”复制标注及其引用的音频到角色目录，并写入角色关联。原始文件不变。复制后的标注使用相对音频路径，可随角色包导出。
- “编辑标注”打开角色目录内的关联副本。“解除关联”移除关联记录，保留标注和音频文件。
- “用于合成”切换到该角色的合成页；关联标注中的音频作为参考候选。单独在标注页打开外部 .list 不会自动关联角色。

替换权重后关闭旧推理 worker，下一次合成加载新文件。合成期间不允许修改权重或标注关联。

## Export a character

In **Models**, open a character’s **Annotations** and link its `.list` once. **Export pack** and **Export packages** put both model weights, the linked `.list` files, and every referenced recording in one ZIP. Shared recordings are included once. The exported lists use relative paths so the recordings appear in **Synthesize** after import.

If a character has no linked list or an audio file is missing, the export shows how to fix that character. A batch still exports the other characters. For older ZIPs with no list declaration, import can link complete lists it finds in the package’s `dataset` folder.

## 角色参数

在合成页调整参数后，点击“保存角色参数”。保存内容只属于当前角色；切换角色或重新打开页面后恢复各自保存值。没有保存值时使用角色推荐值，未提供的项使用应用默认值。

“恢复推荐值”删除当前角色的本地保存值。尚未保存的修改在切换角色或离开合成页后放弃。页面标示“角色推荐”“应用默认”“已保存”或“未保存”。

语速、采样参数、文本语言、切分方式、分段间隔、随机种子、采样步数及超采样按角色保存。批大小、流式开关与输出格式仍是应用设置。

本地保存值写入应用配置的 `synth_role_params`，不覆盖角色包 `config.json.params` 中的作者推荐值，也不随角色包导出。首次升级仅将旧的合成参数迁移给原先选中的角色，不分发给其他角色。

## 验证

- 73 项前端测试通过，包含角色切换、重新挂载、保存失败、恢复失败、旧配置迁移与元数据更新。
- 7 项相关 Rust 测试通过，覆盖可移植复制、导出后重新导入、重复音频去重、解除关联保留文件、过期关联记录拒绝、权重替换与版本更新、合成互斥。
- 前端 lint、TypeScript、八语言文案检查与构建通过；Rust 开发版构建通过。
- Chromium 使用真实页面组件及模拟原生接口验证关联、取消、解除、编辑跳转、版本选择、参数保存和恢复。八语言在 880×640 下弹窗不溢出，下拉选项可实际点击。
- 重启后的原生开发版通过新接口读取现有 4 个角色，每个角色均识别到两份权重与一份关联标注。
- 测试没有改写现有用户模型，也没有使用测试权重进行真实语音推理。临时截图与测试产物位于被忽略的 `data/`。
2026-11-08：模型卡片底部调整为合成、标注和更多三个按钮，删除右键菜单及封面菜单入口。构建、lint、类型和八语言检查通过；Chromium 验证合成跳转、标注弹窗、更多菜单与编辑资料，八语言在 880、1180、1920 像素宽度下共 24 种布局均保持三个按钮同排且不溢出。

## 参考音频记忆

2026-11-08：主参考与辅助参考随选择自动保存，每个角色独立记忆。切换角色、离开合成页和重启后恢复，不需要点击“保存角色参数”。

保存位置是应用配置中的 synth_references:<角色 ID>。标识包含标注文件、音频路径、说话人、语言及文本，不依赖行号。重新排序后仍恢复对应音频；同音频的不同文本可分别选择。文本修改时仅对唯一音频候选恢复，存在歧义时不套用旧选择。缺失或不适用的主参考回退到可用候选，缺失辅助参考不参与合成。

记忆属于本机使用偏好，不改写角色作者推荐参数，也不随角色包导出。

## 权重检查与验证

tools/weight_inspect.py 使用 PyTorch 的 weights_only 与 FakeTensorMode 读取检查点结构；根据上游版本头、词表及 LoRA 元数据识别版本。GPT 多个版本共用同一底模，因此检查实际音素容量和语义词表兼容性，不按两个文件的版本名是否相同判断。

更换时先复制到暂存文件，验证成功才停止旧 worker 并替换。写配置失败时恢复旧权重。校验依赖应用 Python 运行环境；缺少环境时返回明确错误。

本轮验证：

- 前端 104 项测试及完整构建通过，包含导航、试听、缓存、参考标识与独立窗口关闭。
- Rust 权重管理 9 项、Python 小检查点 15 项通过，覆盖错误配对、损坏文件、版本识别和失败回滚。
- 现有 alice_test、alice_v5、amitaro、tsukuyomi 的权重配对，以及 v2Pro、v2ProPlus、v5dev、v5turbo 底模均只读校验通过。
- Chromium 使用真实页面组件与模拟原生接口，验证取消切页保留标注、播放失败、删行停止试听、返回首帧缓存、主/辅助参考按角色恢复，以及标注重排、文本修正和重新加载后恢复。
- 未执行真实训练或真实合成；检查点结构验证不代表音质或完整推理验收。

依据：[上游检查点格式](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/GPT_SoVITS/process_ckpt.py)、[上游 TTS 加载规则](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/GPT_SoVITS/TTS_infer_pack/TTS.py)。

## 旧角色版本识别

导入角色包时，有 Python 运行环境的客户端读取两份检查点并保存实际版本，校验通过后才替换已有角色。环境尚未安装时，角色可先导入，权重校验状态标为待检查。合成 worker 在加载角色时按检查点识别版本和配对，再初始化引擎。七组旧角色均为 v2。合成使用包内训练成品，v2 训练底模通过广场的“训练底模”分类按需下载。

上游底模来源：[GPT-SoVITS v2 底模](https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v2final-pretrained)。
