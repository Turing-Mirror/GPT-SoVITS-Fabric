//! Independent local synthesis capabilities.
use crate::{paths, synth};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_opener::OpenerExt;
use trm_app_protocol::{discovery::Installation, jobs::JobContext, *};
include!(concat!(env!("OUT_DIR"), "/ui_dispatch.rs"));
pub fn headless() -> bool {
    std::env::args().any(|arg| arg == "--headless")
}
struct AudioApp {
    app: AppHandle,
    root: PathBuf,
    listened: std::sync::Mutex<std::collections::HashSet<String>>,
}
pub fn manifest() -> Manifest {
    let parameters = json!({"type":"object","additionalProperties":false,"properties":{
        "text_lang":{"type":"string","enum":["auto","auto_yue","zh","en","ja","ko","yue","all_zh","all_ja","all_ko","all_yue"],"default":"auto"},
        "speed":{"type":"number","minimum":0.25,"maximum":4,"default":1},
        "top_k":{"type":"integer","minimum":1,"maximum":100,"default":15},
        "top_p":{"type":"number","exclusiveMinimum":0,"maximum":1,"default":1},
        "temperature":{"type":"number","exclusiveMinimum":0,"maximum":2,"default":1},
        "repetition_penalty":{"type":"number","minimum":1,"maximum":2,"default":1.35},
        "text_split_method":{"type":"string","enum":["cut0","cut1","cut2","cut3","cut4","cut5"],"default":"cut1"},
        "fragment_interval":{"type":"number","minimum":0,"maximum":2,"default":0.3},
        "seed":{"type":"integer","minimum":-1,"default":-1},
        "sample_steps":{"type":"integer","minimum":1,"maximum":128,"default":32}
    }});
    let mut caps = json!([
        {"id":"gsv.characters","description":"List installed character models and their reference recordings","kind":"query","contractVersion":1,"inputSchema":{"type":"object","title":"本机角色","description":"查看已安装的角色和参考音频。","properties":{},"additionalProperties":false},"resultSchema":{"type":"object","required":["roles"],"properties":{"roles":{"type":"array"}}}},
        {"id":"gsv.synthesize","description":"Synthesize speech using an installed character and a local reference recording. Reuses the application's resident model worker. Returns a job ID.","kind":"job","contractVersion":1,"cancelable":true,"effects":["write_output","gpu_inference"],"inputSchema":{"type":"object","additionalProperties":false,"description":"使用所选角色与参考音频合成语音。","required":["roleId","text","referenceAudio","referenceText","referenceLanguage"],"properties":{
            "roleId":{"type":"string","minLength":1,"x-trm-kind":"resource","x-trm-resource":"gsv.character"},
            "text":{"type":"string","minLength":1},"referenceAudio":{"type":"string","minLength":1,"x-trm-kind":"file","x-trm-media":"audio"},
            "referenceText":{"type":"string"},"referenceLanguage":{"type":"string","enum":["zh","en","ja","ko","yue","all_zh","all_ja","all_ko","all_yue","auto"]},
            "parameters":parameters,"format":{"type":"string","enum":["wav","flac","mp3","m4a"],"default":"wav"},"outputDirectory":{"type":"string","x-trm-kind":"directory"}
        }},"resultSchema":audio_result_schema(&["speech"])}
    ]);
    for cap in caps.as_array_mut().expect("capabilities") {
        cap["inputSchema"]["title"] = json!(if cap["id"] == "gsv.synthesize" {
            "合成语音"
        } else {
            "本机角色"
        });
        label_schema(&mut cap["inputSchema"]);
    }
    Manifest {
        product_id: "com.turingmirror.gpt-sovits-fabric".into(),
        name: "GPT-SoVITS Fabric".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL,
        channel: "neptune".into(),
        capabilities: serde_json::from_value(caps).expect("capabilities"),
        ui: Some(
            json!({"protocol":1,"entry":"index.html","adapter":"tauri-v2","windowCommands":{"tools_open":{"argument":"kind","labels":{"annot":crate::i18n::t("s.annot.title"),"separate":crate::i18n::t("sep.title")}},"tools_open_downloads":{"kind":"main","event":"open-download-models"},"tools_open_help":{"kind":"main","event":"open-help"}},"windows":[{"id":"main"}]}),
        ),
    }
}
impl Application for AudioApp {
    fn manifest(&self) -> Manifest {
        manifest()
    }
    fn status(&self) -> ApiResult {
        Ok(json!({"runtimeReady":paths::runtime_ready(&self.root),"busy":synth::is_busy()}))
    }
    fn resources(&self) -> ApiResult {
        let mut result = synth::list_characters(&self.root);
        result["resources"]=json!(result["roles"].as_array().into_iter().flatten().map(|row|json!({"id":row["id"],"kind":"gsv.character","name":row["name"],"value":row["id"],"metadata":row,"files":row["dir"].as_str().map(|dir|{let dir=PathBuf::from(dir);vec![dir.join("config.json"),dir.join("models/gpt.ckpt"),dir.join("models/sovits.pth")]})})).collect::<Vec<_>>());
        Ok(result)
    }
    fn query(&self, id: &str, _: Value) -> ApiResult {
        if id == "gsv.characters" {
            self.resources()
        } else {
            Err(ApiError::new("capability_not_found", id))
        }
    }
    fn ui_listen(&self, event: &str, events: tokio::sync::broadcast::Sender<Value>) -> ApiResult {
        let mut listened = self.listened.lock().unwrap_or_else(|e| e.into_inner());
        if !listened.contains(event) {
            let name = event.to_string();
            self.app.listen(event.to_string(),move |event| {let payload=serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);let _=events.send(json!({"jsonrpc":"2.0","method":"ui.event","params":{"event":name,"payload":payload}}));});
            listened.insert(event.to_string());
        }
        Ok(json!({}))
    }
    fn ui_file(&self, path: &str) -> ApiResult {
        let path = std::path::Path::new(path).canonicalize()?;
        if !path.is_file() || !self.app.asset_protocol_scope().is_allowed(&path) {
            return Err(ApiError::new(
                "file_not_allowed",
                "File is outside the application's media scope",
            ));
        }
        Ok(json!({"path":path}))
    }
    fn ui_attach(&self) -> ApiResult {
        if let Some(win) = self.app.get_webview_window("main") {
            win.hide().map_err(|e| ApiError::new("window_failed", e))?;
        }
        Ok(json!({}))
    }
    fn ui_invoke(&self, command: &str, args: Value) -> ApiResult {
        match command {
            "plugin:opener|open_url" => {
                self.app
                    .opener()
                    .open_url(
                        args["url"]
                            .as_str()
                            .ok_or_else(|| ApiError::invalid("Missing URL"))?,
                        None::<&str>,
                    )
                    .map_err(|e| ApiError::new("open_failed", e))?;
                Ok(json!({}))
            }
            "plugin:opener|open_path" => {
                self.app
                    .opener()
                    .open_path(
                        args["path"]
                            .as_str()
                            .ok_or_else(|| ApiError::invalid("Missing path"))?,
                        None::<&str>,
                    )
                    .map_err(|e| ApiError::new("open_failed", e))?;
                Ok(json!({}))
            }
            "plugin:event|emit" | "plugin:event|emit_to" => {
                use tauri::Emitter;
                self.app
                    .emit(
                        args["event"]
                            .as_str()
                            .ok_or_else(|| ApiError::invalid("Missing event"))?,
                        args["payload"].clone(),
                    )
                    .map_err(|e| ApiError::new("event_failed", e))?;
                Ok(json!({}))
            }
            _ => tauri::async_runtime::block_on(dispatch_ui(self.app.clone(), command, args)),
        }
    }
    fn show(&self) -> ApiResult {
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || show_window(&app))
            .map_err(|e| ApiError::new("window_failed", e))?;
        Ok(json!({}))
    }
    fn quit(&self) -> ApiResult {
        if synth::is_busy() {
            return Err(ApiError::new(
                "application_busy",
                "An operation is still running",
            ));
        }
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            app.exit(0);
        });
        Ok(json!({}))
    }
    fn execute(&self, ctx: JobContext, id: &str, args: Value) -> ApiResult {
        ctx.check()?;
        if id != "gsv.synthesize" {
            return Err(ApiError::new("capability_not_found", id));
        }
        if !paths::runtime_ready(&self.root) {
            return Err(ApiError::new(
                "runtime_missing",
                "Install the application's runtime first",
            ));
        }
        let role_id = args["roleId"].as_str().unwrap_or_default();
        let (role_dir, role) = synth::find_character_config(&self.root, role_id)
            .ok_or_else(|| ApiError::new("resource_missing", "Character is not installed"))?;
        let output = args["outputDirectory"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| paths::user_data(&self.root).join("api/outputs"))
            .join(&ctx.id);
        std::fs::create_dir_all(&output)?;
        crate::asset_scope::grant_dir(&self.app, &output);
        let mut params = role["params"].as_object().cloned().unwrap_or_default();
        if let Some(input) = args["parameters"].as_object() {
            params.extend(input.clone());
        }
        let opts = json!({"owner":ctx.id,"job_id":ctx.id,"output_dir":output,"format":args["format"].as_str().unwrap_or("wav"),"role_name":role["name"].as_str().unwrap_or(role_id)});
        let mut listeners = Vec::new();
        for event in ["synth-chunk", "synth-done", "synth-error"] {
            let observer = ctx.clone();
            listeners.push(self.app.listen(event, move |event| {
                if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                    if value["owner"].as_str() == Some(&observer.id) {
                        observer.progress(value);
                    }
                }
            }));
        }
        let ended = Arc::new(AtomicBool::new(false));
        let stop = ended.clone();
        let observer = ctx.clone();
        let watcher = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                if observer.canceled.load(Ordering::Acquire) {
                    synth::cancel_for(Some(&observer.id));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let result = synth::synthesize(
            &self.app,
            &self.root,
            role_id,
            &role_dir,
            role["version"].as_str().unwrap_or("v2ProPlus"),
            args["text"].as_str().unwrap(),
            args["referenceAudio"].as_str().unwrap(),
            args["referenceText"].as_str().unwrap(),
            args["referenceLanguage"].as_str().unwrap(),
            &Value::Object(params),
            false,
            &opts,
        );
        ended.store(true, Ordering::Release);
        let _ = watcher.join();
        for listener in listeners {
            self.app.unlisten(listener);
        }
        let result = result.map_err(|e| {
            if ctx.canceled.load(Ordering::Acquire) {
                ApiError::canceled()
            } else {
                ApiError::new("synthesis_failed", e)
            }
        })?;
        if result["cancelled"].as_bool() == Some(true) {
            return Err(ApiError::canceled());
        }
        let path = PathBuf::from(
            result["out"]
                .as_str()
                .ok_or_else(|| ApiError::new("output_missing", "No speech output"))?,
        );
        let probe = paths::audio_tool(&self.root, "ffprobe")
            .ok_or_else(|| ApiError::new("audio_tools_missing", "Audio probe is unavailable"))?;
        let artifact = trm_app_protocol::media::audio_artifact(
            &probe,
            &path,
            "speech",
            &format!("{}:0", ctx.id),
        )?;
        Ok(json!({"jobId":ctx.id,"artifacts":[artifact],"timing":result}))
    }
}
pub fn start(app: &AppHandle, root: PathBuf) -> Result<(), String> {
    let installation = Installation::new(
        manifest(),
        std::env::current_exe().map_err(|e| e.to_string())?,
        root.clone(),
        crate::ui_assets::external_dir(),
    );
    let service = Service::new(
        Arc::new(AudioApp {
            app: app.clone(),
            root: root.clone(),
            listened: std::sync::Mutex::new(std::collections::HashSet::new()),
        }),
        installation,
        paths::user_data(&root).join("api/jobs.json"),
    )
    .map_err(|e| e.to_string())?;
    service.start().map_err(|e| e.to_string())?;
    app.manage(service);
    Ok(())
}

pub fn main_url() -> String {
    if cfg!(windows) {
        format!("http://{}.localhost/index.html", crate::ui_assets::SCHEME)
    } else {
        format!("{}://localhost/index.html", crate::ui_assets::SCHEME)
    }
}
pub fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.url().ok().is_some_and(|url| url.scheme() == "about") {
            let _ = win.navigate(main_url().parse().expect("UI URL"));
        }
        crate::window_watch::rescue(&win);
        let _ = win.set_focus();
    }
}

fn label_schema(schema: &mut Value) {
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        for (key, child) in properties {
            let title = [
                ("input", "输入音频"),
                ("modelPath", "音色模型"),
                ("indexPath", "索引文件"),
                ("pitch", "音高"),
                ("f0method", "音高提取方法"),
                ("indexRate", "索引比例"),
                ("protect", "清辅音保护"),
                ("rmsMixRate", "响度包络比例"),
                ("format", "输出格式"),
                ("outputDirectory", "输出目录"),
                ("model", "分离模型"),
                ("aggression", "分离强度"),
                ("tracks", "音轨"),
                ("path", "音频文件"),
                ("gainDb", "增益（dB）"),
                ("offsetMs", "偏移（毫秒）"),
                ("sampleRate", "采样率"),
                ("channels", "声道"),
                ("limiter", "限制峰值"),
                ("roleId", "角色"),
                ("text", "合成文本"),
                ("referenceAudio", "参考音频"),
                ("referenceText", "参考文本"),
                ("referenceLanguage", "参考语言"),
                ("parameters", "合成参数"),
                ("text_lang", "文本语言"),
                ("speed", "语速"),
                ("top_k", "候选数量"),
                ("top_p", "采样范围"),
                ("temperature", "采样温度"),
                ("repetition_penalty", "重复惩罚"),
                ("text_split_method", "切句方式"),
                ("fragment_interval", "句间间隔"),
                ("seed", "随机种子"),
                ("sample_steps", "采样步数"),
            ]
            .into_iter()
            .find(|(name, _)| *name == key.as_str())
            .map(|(_, label)| label);
            if let Some(title) = title {
                child["title"] = json!(title);
            }
            label_schema(child);
        }
    }
    if let Some(items) = schema.get_mut("items") {
        label_schema(items);
    }
}
