//! `.list` 标注文件的读、校、写。
//!
//! GPT-SoVITS 的一行标注长这样：
//!
//! ```text
//! audios/0001.wav|爱丽丝|JA|ブルーアーカイブ
//! ```
//!
//! 四段：音频路径、说话人、语种、文本。路径**相对 .list 所在目录**（角色包
//! 约定见 docs/DECISIONS.md 的 D4），所以这里所有的绝对路径都是当场拼出来
//! 给界面播放用的，不写回文件。
//!
//! 这个模块只做三件事，而且刻意都做成同步的纯函数：解析一行、给一行挑毛病、
//! 把一批行写回去。挑毛病的部分是这里唯一有判断的地方 —— 标注坏掉的方式就
//! 那么几种（文件不在、字段数不对、文本空、同一个音频出现两次、语种写错），
//! 每一种都直接对应用户接下来要做的一个动作，所以按种类分开报，而不是笼统
//! 地说一句「第 47 行有问题」。
//!
//! 文件不在时先按文件名找回（见 `relocate`）：默认找 .list 所在目录，用户
//! 也可以在编辑器里另选一个音频目录。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use serde_json::{json, Value};

/// 上游认得的语种记号。大小写不敏感 —— 素材库里 `ZH` 和 `zh` 都见过。
///
/// 这份表是**提示**用的，不是闸门：写了表外的记号只会得到一条 warn，行照样
/// 存得下去。上游随时可能加新语种，而这个软件不该因为自己的表旧了就拒绝
/// 保存用户的标注。
const KNOWN_LANGS: &[&str] = &["zh", "ja", "en", "ko", "yue", "all_zh", "all_ja", "all_ko", "auto"];

/// 一行标注在界面里的样子。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    /// 原始行号（1 起）。删行之后不重排 —— 用户报错时说的是「第几行」。
    pub line: usize,
    /// 写在文件里的那个相对路径，原样。
    pub wav: String,
    pub speaker: String,
    pub lang: String,
    pub text: String,
    /// 拼出来的绝对路径，给界面播放用。文件不在时也给，界面自己按 exists 判断。
    #[serde(default)]
    pub abs: String,
    #[serde(default)]
    pub exists: bool,
    /// 这一行的毛病，见 `issues_of`。空 = 干净。
    #[serde(default)]
    pub issues: Vec<String>,
    /// 按文件名找回的新路径，保存时写回 `wav`。在 .list 所在目录之下时是相对
    /// 路径，否则是绝对路径。空 = 没有找回。
    #[serde(default)]
    pub found: String,
    /// 找到了多个同名文件，分不出是哪一个。这种情况不猜，留给用户选目录。
    #[serde(default)]
    pub ambiguous: bool,
}

/// 解析一行。返回 None = 空行或注释，调用方跳过。
///
/// 用 `splitn(4, '|')` 而不是 `split('|')`：文本里出现竖线不是没有过（日语的
/// 「｜」是全角，但转写时被人手打成半角的情况见过），前三段定死，剩下的全归
/// 文本。反过来写就会把人家的台词从中间劈开。
fn parse_line(line: &str) -> Option<Row> {
    let t = line.trim_end_matches(['\r', '\n']);
    if t.trim().is_empty() || t.trim_start().starts_with('#') {
        return None;
    }
    let mut it = t.splitn(4, '|');
    let wav = it.next().unwrap_or("").trim().to_string();
    let speaker = it.next().unwrap_or("").trim().to_string();
    let lang = it.next().unwrap_or("").trim().to_string();
    let text = it.next().unwrap_or("").trim().to_string();
    Some(Row {
        line: 0,
        wav,
        speaker,
        lang,
        text,
        abs: String::new(),
        exists: false,
        issues: Vec::new(),
        found: String::new(),
        ambiguous: false,
    })
}

/// 一行的毛病清单。记号是给界面用的，文案在语言包里。
fn issues_of(r: &Row, dup: bool) -> Vec<String> {
    let mut out = Vec::new();
    if r.wav.is_empty() {
        out.push("no_wav".into());
    } else if !r.exists {
        out.push("missing".into());
        if r.ambiguous {
            out.push("ambiguous".into());
        }
    }
    if r.speaker.is_empty() {
        out.push("no_speaker".into());
    }
    if r.lang.is_empty() {
        out.push("no_lang".into());
    } else if !KNOWN_LANGS.contains(&r.lang.to_ascii_lowercase().as_str()) {
        out.push("odd_lang".into());
    }
    if r.text.is_empty() {
        out.push("no_text".into());
    }
    if dup {
        out.push("dup".into());
    }
    out
}

/// Windows 上大小写不敏感、分隔符两种都收，比路径要归一化一次。
fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_ascii_lowercase()
}

impl Row {
    pub(crate) fn is_complete(&self) -> bool {
        !self.wav.is_empty()
            && !self.speaker.is_empty()
            && !self.lang.is_empty()
            && !self.text.is_empty()
    }
}

pub(crate) fn parse_rows(text: &str) -> Vec<Row> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let mut row = parse_line(line)?;
            row.line = index + 1;
            Some(row)
        })
        .collect()
}

/// 找回音频时最多翻看的目录项数与目录层数。用户选到整块盘时不至于卡住。
const SEARCH_MAX_ENTRIES: usize = 200_000;
const SEARCH_MAX_DEPTH: usize = 16;

/// .list 所在的目录，也是行里相对路径的起点。
fn list_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// 路径切成小写的各段，去掉盘符和空段。别的电脑写下的 Windows 绝对路径
/// 和这里的路径因此可以逐段比较。
fn segments(p: &str) -> Vec<String> {
    p.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && !s.ends_with(':'))
        .map(str::to_lowercase)
        .collect()
}

/// 按行里写的路径拼出绝对路径并检查文件在不在。上一次找回的结果一并清掉，
/// 编辑器传回来的行可能已经改过路径。
fn resolve(rows: &mut [Row], base: &Path) {
    for row in rows {
        row.found.clear();
        row.ambiguous = false;
        row.exists = false;
        row.abs.clear();
        if !row.wav.is_empty() {
            let abs = base.join(row.wav.replace('\\', "/"));
            row.exists = abs.is_file();
            row.abs = abs.to_string_lossy().into_owned();
        }
    }
}

/// 在这些目录下找出文件名在 `wanted` 里的文件，按小写文件名归类。
fn index_files(dirs: &[PathBuf], wanted: &HashSet<String>) -> HashMap<String, Vec<PathBuf>> {
    let mut out: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut seen = 0usize;
    let mut stack: Vec<(PathBuf, usize)> = dirs.iter().map(|d| (d.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > SEARCH_MAX_ENTRIES {
                return out;
            }
            let Ok(ty) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_lowercase();
            if ty.is_dir() {
                // 点开头的目录是暂存或隐藏目录，里面的副本不该被当成原件。
                if depth < SEARCH_MAX_DEPTH && !name.starts_with('.') {
                    stack.push((e.path(), depth + 1));
                }
            } else if ty.is_file() && wanted.contains(&name) {
                let list = out.entry(name).or_default();
                let p = e.path();
                if !list.contains(&p) {
                    list.push(p);
                }
            }
        }
    }
    out
}

/// 同名文件里挑出和原路径最像的一个：比较路径末尾有几段相同。
/// 最像的不止一个时返回 None，不猜。
fn choose<'a>(wav: &str, cands: &'a [PathBuf]) -> Option<&'a PathBuf> {
    if cands.len() == 1 {
        return cands.first();
    }
    let want = segments(wav);
    let score = |c: &PathBuf| {
        let have = segments(&c.to_string_lossy());
        want.iter().rev().zip(have.iter().rev()).take_while(|(a, b)| a == b).count()
    };
    let best = cands.iter().map(score).max()?;
    let mut top = cands.iter().filter(|c| score(c) == best);
    let first = top.next();
    if top.next().is_some() { None } else { first }
}

/// 写回标注用的路径：在 .list 所在目录之下写相对路径，否则写绝对路径。
fn written_path(base: &Path, file: &Path) -> String {
    match file.strip_prefix(base) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => file.to_string_lossy().into_owned(),
    }
}

/// 按文件名在 `dirs` 下找回缺失的音频，返回找回的行数。
///
/// 标注被挪过位置、或者是在别的电脑上用绝对路径写的，都只是目录对不上，
/// 文件名通常还在。找到的结果只放在 `abs` 和 `found` 里，不改 `wav`：
/// 训练和合成直接用 `abs`，标注文件要等用户在编辑器里保存才改。
fn relocate(rows: &mut [Row], base: &Path, dirs: &[PathBuf]) -> usize {
    let wanted: HashSet<String> = rows
        .iter()
        .filter(|r| !r.exists && !r.wav.is_empty())
        .filter_map(|r| segments(&r.wav).pop())
        .collect();
    if wanted.is_empty() {
        return 0;
    }
    let index = index_files(dirs, &wanted);
    let mut n = 0;
    for r in rows.iter_mut().filter(|r| !r.exists && !r.wav.is_empty()) {
        let Some(cands) = segments(&r.wav).pop().and_then(|name| index.get(&name)) else {
            continue;
        };
        match choose(&r.wav, cands) {
            Some(file) => {
                r.abs = file.to_string_lossy().into_owned();
                r.exists = true;
                r.found = written_path(base, file);
                n += 1;
            }
            None => r.ambiguous = true,
        }
    }
    n
}

/// 查重并填上每一行的毛病。
fn finish(rows: &mut [Row]) {
    // 同一个音频出现两次：训练时它会被喂两遍，合成台的参考列表里也会出现
    // 两条一模一样的候选。先数一遍再回填，单趟做不出来。
    let key = |r: &Row| norm(if r.found.is_empty() { &r.wav } else { &r.found });
    let mut seen: HashMap<String, usize> = HashMap::new();
    for r in rows.iter() {
        if !r.wav.is_empty() {
            *seen.entry(key(r)).or_insert(0) += 1;
        }
    }
    for r in rows.iter_mut() {
        let dup = !r.wav.is_empty() && seen.get(&key(r)).copied().unwrap_or(0) > 1;
        r.issues = issues_of(r, dup);
    }
}

/// 读取并校验标注行，供标注编辑器、合成台和训练共用。缺失的音频会先在
/// .list 所在目录下按文件名找一遍。
pub(crate) fn read_rows(path: &Path) -> Result<Vec<Row>, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let base = list_dir(path);
    let mut rows = parse_rows(&raw);
    resolve(&mut rows, &base);
    relocate(&mut rows, &base, std::slice::from_ref(&base));
    finish(&mut rows);
    Ok(rows)
}

/// 选择音频目录，并允许界面播放其中的音频。原生对话框要主线程。
pub fn pick_audio_dir(win: Option<&tauri::WebviewWindow>) -> Option<String> {
    let picked = crate::shell_extras::dialog_on(win)
        .set_title(&crate::i18n::t("s.annot.audioDirTitle"))
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned());
    if let (Some(win), Some(p)) = (win, picked.as_ref()) {
        crate::asset_scope::grant_dir(win.app_handle(), Path::new(p));
    }
    picked
}

/// 编辑器里选了音频目录：在那个目录下找回仍然缺失的音频。`rows` 是编辑器
/// 里当前的行，可能带着没保存的改动。
pub fn relocate_in(path: &str, mut rows: Vec<Row>, dir: &str) -> Result<Value, String> {
    let base = list_dir(Path::new(path));
    resolve(&mut rows, &base);
    relocate(&mut rows, &base, &[PathBuf::from(dir)]);
    finish(&mut rows);
    Ok(summary(path, rows))
}

/// 读取标注编辑器所需的行与统计信息。
pub fn load(path: &str) -> Result<Value, String> {
    Ok(summary(path, read_rows(Path::new(path))?))
}

/// 编辑器拿到的行与统计。找回的行直接换成新路径，保存时写回文件。
fn summary(path: &str, mut rows: Vec<Row>) -> Value {
    let base = list_dir(Path::new(path));
    let relocated = rows.iter().filter(|r| !r.found.is_empty()).count();
    for r in &mut rows {
        if !r.found.is_empty() {
            r.wav = r.found.clone();
        }
    }
    let ambiguous = rows.iter().filter(|r| r.ambiguous).count();
    let bad = rows.iter().filter(|r| !r.issues.is_empty()).count();
    let missing = rows.iter().filter(|r| r.issues.iter().any(|i| i == "missing")).count();
    let speakers = {
        let mut v: Vec<String> = rows
            .iter()
            .map(|r| r.speaker.clone())
            .filter(|s| !s.is_empty())
            .collect();
        v.sort();
        v.dedup();
        v
    };

    json!({
        "path": path,
        "dir": base.to_string_lossy(),
        "rows": rows,
        "total": rows.len(),
        "bad": bad,
        "missing": missing,
        "relocated": relocated,
        "ambiguous": ambiguous,
        "speakers": speakers,
    })
}

/// 把一批行写回去。
///
/// 先写同目录的临时文件再改名，中途断电不会留下半份标注 —— 标注是用户一句
/// 一句校出来的，是这个软件里最贵的东西，不能拿它冒险。第一次写之前留一份
/// `.list.bak`；只留第一次那份，之后不再覆盖，否则连着存三次就把原始那份
/// 冲没了，而用户想回的正是最开始那份。
pub fn save(path: &str, rows: &[Row]) -> Result<Value, String> {
    let p = Path::new(path);
    if !p.parent().map(Path::is_dir).unwrap_or(false) {
        return Err(crate::i18n::t("s.annot.errNoDir"));
    }
    let mut body = String::with_capacity(rows.len() * 64);
    for r in rows {
        // 字段里混进竖线就再也读不回来了。前三段是我们自己拼的，只可能是
        // 用户在界面里打进去的，就地换成全角 —— 直接拒绝保存等于让他在一个
        // 几千行的表里自己找是哪一格。
        let f = |s: &str| s.replace('|', "｜").replace(['\r', '\n'], " ");
        body.push_str(&f(&r.wav));
        body.push('|');
        body.push_str(&f(&r.speaker));
        body.push('|');
        body.push_str(&f(&r.lang));
        body.push('|');
        body.push_str(&f(&r.text));
        body.push('\n');
    }

    let bak = p.with_extension("list.bak");
    if p.is_file() && !bak.exists() {
        let _ = fs::copy(p, &bak);
    }
    let tmp = p.with_extension("list.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, p).map_err(|e| format!("{path}: {e}"))?;
    Ok(json!({ "path": path, "written": rows.len(), "backup": bak.is_file() }))
}

/// 选一份 .list。顺手把它所在的目录放进 asset 白名单 —— 界面要播那些音频。
pub fn pick(win: Option<&tauri::WebviewWindow>) -> Option<String> {
    let picked = crate::shell_extras::dialog_on(win)
        .set_title(&crate::i18n::t("s.annot.pickTitle"))
        .add_filter(&crate::i18n::t("s.annot.pickFilter"), &["list", "txt"])
        .pick_file()
        .map(|p| p.to_string_lossy().into_owned());
    if let (Some(win), Some(p)) = (win, picked.as_ref()) {
        if let Some(dir) = Path::new(p).parent() {
            crate::asset_scope::grant_dir(win.app_handle(), dir);
        }
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_in_the_text_does_not_split_the_line() {
        let r = parse_line("audios/a.wav|爱丽丝|JA|前半|后半").unwrap();
        assert_eq!(r.wav, "audios/a.wav");
        assert_eq!(r.lang, "JA");
        assert_eq!(r.text, "前半|后半");
    }

    #[test]
    fn blank_and_comment_lines_are_not_rows() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("# 这是注释").is_none());
    }

    #[test]
    fn lang_case_does_not_matter_but_nonsense_is_flagged() {
        let mut r = parse_line("a.wav|s|zh|文本").unwrap();
        r.exists = true;
        assert!(issues_of(&r, false).is_empty());
        let mut r2 = parse_line("a.wav|s|ZH|文本").unwrap();
        r2.exists = true;
        assert!(issues_of(&r2, false).is_empty());
        let mut r3 = parse_line("a.wav|s|klingon|文本").unwrap();
        r3.exists = true;
        assert_eq!(issues_of(&r3, false), vec!["odd_lang".to_string()]);
    }

    #[test]
    fn duplicate_audio_paths_are_reported_on_both_rows() {
        let dir = crate::testutil::scratch("annot_dup_test");
        let _ = fs::create_dir_all(dir.join("audios"));
        fs::write(dir.join("audios/a.wav"), b"x").unwrap();
        let list = dir.join("x.list");
        fs::write(&list, "audios/a.wav|s|zh|一\nAUDIOS\\A.WAV|s|zh|二\n").unwrap();
        let v = load(&list.to_string_lossy()).unwrap();
        let rows = v["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        for r in rows {
            let iss: Vec<String> = serde_json::from_value(r["issues"].clone()).unwrap();
            assert!(iss.contains(&"dup".to_string()), "{iss:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_keeps_the_first_original_as_a_backup() {
        let dir = crate::testutil::scratch("annot_save_test");
        let _ = fs::create_dir_all(&dir);
        let list = dir.join("y.list");
        fs::write(&list, "a.wav|s|zh|原始\n").unwrap();
        let path = list.to_string_lossy().into_owned();

        let rows = vec![Row {
            line: 1,
            wav: "a.wav".into(),
            speaker: "s".into(),
            lang: "zh".into(),
            text: "第一次改".into(),
            abs: String::new(),
            exists: false,
            issues: vec![],
            found: String::new(),
            ambiguous: false,
        }];
        save(&path, &rows).unwrap();
        let bak = list.with_extension("list.bak");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "a.wav|s|zh|原始\n");

        let rows2 = vec![Row { text: "第二次改".into(), ..rows[0].clone() }];
        save(&path, &rows2).unwrap();
        // 备份还是最开始那份，没有被第二次保存冲掉。
        assert_eq!(fs::read_to_string(&bak).unwrap(), "a.wav|s|zh|原始\n");
        assert_eq!(fs::read_to_string(&list).unwrap(), "a.wav|s|zh|第二次改\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pipe_typed_into_a_field_becomes_full_width_instead_of_corrupting_the_file() {
        let dir = crate::testutil::scratch("annot_pipe_test");
        let _ = fs::create_dir_all(&dir);
        let list = dir.join("z.list");
        let path = list.to_string_lossy().into_owned();
        let rows = vec![Row {
            line: 1,
            wav: "a.wav".into(),
            speaker: "a|b".into(),
            lang: "zh".into(),
            text: "文本".into(),
            abs: String::new(),
            exists: false,
            issues: vec![],
            found: String::new(),
            ambiguous: false,
        }];
        save(&path, &rows).unwrap();
        let back = fs::read_to_string(&list).unwrap();
        assert_eq!(back, "a.wav|a｜b|zh|文本\n");
        // 读回来仍然是四段。
        let r = parse_line(back.trim()).unwrap();
        assert_eq!(r.text, "文本");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_moved_audio_is_found_by_its_file_name() {
        let dir = crate::testutil::scratch("annot_relocate_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("new/spk")).unwrap();
        fs::write(dir.join("new/spk/a.wav"), b"x").unwrap();
        let list = dir.join("x.list");
        fs::write(&list, "D:\\GPT-SoVITS\\output\\slicer_opt\\A.wav|s|zh|一\nb.wav|s|zh|二\n").unwrap();
        let rows = read_rows(&list).unwrap();
        assert!(rows[0].exists);
        assert_eq!(rows[0].found, "new/spk/a.wav");
        // 训练和合成只看 abs，行里原来写的路径要等保存才改。
        assert!(rows[0].wav.starts_with("D:"));
        assert!(!rows[1].exists);
        assert!(rows[1].issues.contains(&"missing".to_string()));
        let v = load(&list.to_string_lossy()).unwrap();
        assert_eq!(v["relocated"], 1);
        assert_eq!(v["rows"][0]["wav"], "new/spk/a.wav");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_named_files_are_told_apart_by_their_folders_or_left_alone() {
        let dir = crate::testutil::scratch("annot_ambiguous_test");
        let _ = fs::remove_dir_all(&dir);
        for sub in ["x/alice", "x/bob", "y/alice"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("x/alice/1.wav"), b"x").unwrap();
        fs::write(dir.join("x/bob/1.wav"), b"x").unwrap();
        fs::write(dir.join("x/bob/2.wav"), b"x").unwrap();
        fs::write(dir.join("y/alice/2.wav"), b"x").unwrap();
        let list = dir.join("x.list");
        fs::write(&list, "old/bob/1.wav|s|zh|一\nold/carol/2.wav|s|zh|二\n").unwrap();
        let rows = read_rows(&list).unwrap();
        assert_eq!(rows[0].found, "x/bob/1.wav");
        assert!(!rows[1].exists);
        assert!(rows[1].ambiguous);
        assert!(rows[1].issues.contains(&"ambiguous".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chosen_audio_folder_outside_the_list_is_written_as_absolute() {
        let dir = crate::testutil::scratch("annot_pick_dir_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("lists")).unwrap();
        fs::create_dir_all(dir.join("audio/deep/er")).unwrap();
        fs::write(dir.join("audio/deep/er/c.wav"), b"x").unwrap();
        let list = dir.join("lists/x.list");
        fs::write(&list, "c.wav|s|zh|三\n").unwrap();
        let path = list.to_string_lossy().into_owned();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded["missing"], 1);
        let rows: Vec<Row> = serde_json::from_value(loaded["rows"].clone()).unwrap();
        let v = relocate_in(&path, rows, &dir.join("audio").to_string_lossy()).unwrap();
        assert_eq!(v["relocated"], 1);
        assert_eq!(v["missing"], 0);
        let wav = v["rows"][0]["wav"].as_str().unwrap();
        assert!(Path::new(wav).is_absolute() && wav.ends_with("c.wav"), "{wav}");
        let _ = fs::remove_dir_all(&dir);
    }
}
