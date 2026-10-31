# GPT-SoVITS-Fabric · en-US

| 当前键名 | 原对照表行号 | 应用文本 |
| --- | --- | --- |
| `glossary.terms.gpt_weights.detail` | L86 | Controls pause cadence, stress placement, and intonation contours, determining the prosody of synthesized speech. It turns text into semantic tokens and determines phrasing, stress, and tone. It is the .ckpt file in a voice pack. |
| `glossary.terms.sovits_weights.detail` | L87 | Renders prosodic features into the target speaker's vocal timbre and acoustic texture, determining voice similarity. It turns semantic tokens into a waveform and determines the timbre. It is the .pth file in a voice pack. The two weights must be used as a matched pair; a mismatched pair produces noise. |
| `msg.sep.no_request` | L101 | Missing request file parameter |
| `msg.sep.empty_fields` | L102 | Model, input path, and output path cannot be empty |
| `msg.train.oom` | L104 | Insufficient GPU memory. Lower the Batch Size or close other GPU-intensive applications and try again<br>Current batch size: {batch} |
| `s.04c4e3b2b3` | L113 | Download failed: {e} |
| `s.1455f353e7` | L115 | Failed to save file: {e} |
| `s.703e6f531a` | L120 | Verifying and extracting large component archives; exact percentage progress is unavailable during this stage, please wait… |
| `s.7dc4ea39fd` | L124 | The training process exited without returning a result; please expand the bottom log panel to investigate |
| `s.bc94a9c280` | L127 | Advanced option; keeping the default value is generally recommended |
| `s.provCoreDone` | L132 | Core components installed. Speech synthesis and model training are now ready to use. |
| `s.9a79ee8bcd` | L136 | Resumable downloads are supported; retrying will continue from where the download left off. |
| `s.errActDownload` | L137 | Go to Downloads |
| `s.cleanupDataset` | L142 | Clean up temporary dataset files (sliced segments, ASR transcripts, and feature caches) |
| `s.annot.dropChanges` | L150 | You have unsaved changes. Are you sure you want to discard them? |
| `glossary.terms.prompt_text.detail` | L157 | Enter the exact transcript and punctuation spoken in the reference audio; mismatches between transcript and audio may cause skipped words or timbre distortion. It must match the audio exactly; otherwise the model misjudges the pronunciation and the voice becomes unstable. Voice packs already include it in their .list files, so it rarely needs to be entered by hand. |
| `synth.pSpeedTip` | L160 | Values above 1.0 speed up speech and values below 1.0 slow it down; extreme adjustments may reduce vocal naturalness. |
| `train.sepEntryDesc` | L172 | When your training recordings contain background music or accompaniment, extract clean vocals here first before slicing and training. |
| `s.7f3ebfb67b` | L184 | You've already synthesized speech 10 times! GPT-SoVITS Fabric is completely free—if you find it helpful, follow Turing Mirror to support us~ (This notice appears only once) |
