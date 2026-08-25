// 合成引擎托管（原型）。
//
//! 状态：M1 待接线。本模块暂未注册进 lib.rs 的 invoke_handler，避免在
//! Windows 工具链验证完成前影响既有构建；协议与生命周期已在
//! engine-payload/tools/synth_worker.py 侧定稿。
//!
//! 计划接线方式（对照 sts.rs）：
//!   * spawn：Runtime\pythonw.exe tools\synth_worker.py --resident --lru 2
//!   * 协议：stdin/stdout 每行一条 JSON（见 worker 头注释），ready 行表示可接活
//!   * 取消：200ms 轮询 cancel 标志，与输出 channel 解耦（长分片静默期可秒取消）
//!   * 事件：synth-progress / synth-chunk 转发给前端；BUSY 互斥沿用 ToolPidGuard

#![allow(dead_code)]

use serde::Deserialize;

/// 一条合成请求（前端 invoke → 本模块 → worker stdin）。
#[derive(Debug, Deserialize)]
pub struct SynthRequest {
    pub job: String,
    pub text: String,
    /// .list 行中的音频路径（相对角色包根）。
    pub ref_wav: String,
    pub ref_text: String,
    pub ref_lang: String,
    /// 角色包 config.json 内嵌的作者推荐参数；用户覆盖后以用户值为准。
    #[serde(default)]
    pub params: Option<SynthParams>,
    #[serde(default = "default_true")]
    pub streaming: bool,
}

#[derive(Debug, Deserialize)]
pub struct SynthParams {
    #[serde(default = "one_f")]
    pub speed: f32,
    #[serde(default = "k15")]
    pub top_k: u32,
    #[serde(default = "one_f")]
    pub top_p: f32,
    #[serde(default = "one_f")]
    pub temperature: f32,
    #[serde(default = "p135")]
    pub repetition_penalty: f32,
}

fn default_true() -> bool {
    true
}
fn one_f() -> f32 {
    1.0
}
fn k15() -> u32 {
    15
}
fn p135() -> f32 {
    1.35
}

/// 加载时对包内 params 做范围钳制，防止离谱推荐值破坏体验。
/// （与 D4 决策一致：未知字段忽略、越界值收敛到合法区间。）
pub fn clamp_params(p: &mut SynthParams) {
    p.speed = p.speed.clamp(0.5, 2.0);
    p.top_k = p.top_k.clamp(1, 100);
    p.top_p = p.top_p.clamp(0.0, 1.0);
    p.temperature = p.temperature.clamp(0.0, 1.0);
    p.repetition_penalty = p.repetition_penalty.clamp(1.0, 2.0);
}
