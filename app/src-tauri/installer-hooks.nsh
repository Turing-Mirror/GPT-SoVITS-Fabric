; GPT-SoVITS Fabric —— NSIS 安装器钩子
;
; Tauri 的 NSIS 模板本来就做的事，这里不要重复做：
;   - 目录选择页（正常安装显示，OTA 静默安装自动跳过）
;   - 把安装目录写进 HKCU\Software\Turing-Mirror\GPT-SoVITS Fabric，下次升级读回来
;   - 默认装到 %LOCALAPPDATA%\GPT-SoVITS Fabric，不要管理员权限
;   - 按打包清单删除随包文件（RMDir 不带 /r，事后下载的东西它不认识）
;
; 这里只补模板做不到的一件事：**清事后下载/生成的残留**。Runtime 是几个 GB
; 的 Python 环境、pretrained_models 是几百 MB 底模，两者都不在打包清单里，
; 模板卸载完会原样留在盘上。训练产物在 User_Data\train 下，跟着「是否保留
; 用户数据」一起走。
;
; ── 这份文件以前整份是 RVC Fabric 的 ─────────────────────────────────────
; 90 行里 8 处写着 RVC：注册表键 `HKCU\Software\Turing-Mirror\RVC Fabric`、
; 默认目录 `%LOCALAPPDATA%\RVC Fabric`、卸载删「RVC Fabric 启动器.lnk」。
; 而 tauri.conf.json 的 productName 已经是 GPT-SoVITS Fabric —— 两边对不上，
; 装的是一个名字、清理的是另一个名字，卸载必留残骸。
;
; 里面还有整段「清掉 Python 双程序版残骸」「拆掉 Inno 那一套的痕迹」——
; 那是 RVC 从旧架构迁过来的历史。**这个产品从来没发布过**，没有任何旧版本
; 需要迁移，那些 Delete 一条都不会命中。
;
; 非 ASCII 路径的警告也删了。RVC 那条的理由是「faiss 读不了检索库」，
; 这个产品没有检索库；而上游 GPT-SoVITS 在每一处 torch.save 都自带了
; `my_save` 绕开中文路径（process_ckpt.py / utils.py / prepare_datasets 全都有）。
; 没有证据说明中文路径会坏，就不该弹一个吓人的框。真在内测里撞见了，
; 带着真实的理由再加回来。

Var KeepUserData

!macro NSIS_HOOK_PREINSTALL
  ; 装新版之前先停掉旧版留下的进程。不停的话 Runtime\pythonw.exe 还攥着
  ; DLL，覆盖安装会写不进去，用户看到的是「安装失败」而不是「请先退出」。
  ; 只按 ExecutablePath 前缀匹配 $INSTDIR —— 绝不 taskkill pythonw，
  ; 那会误伤用户开着的别的 Python 程序。
  IfSilent skip_preinstall_kill
  nsExec::ExecToLog 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p = [IO.Path]::GetFullPath(''$INSTDIR''); Get-CimInstance Win32_Process | ForEach-Object { $$e = [string]$$_.ExecutablePath; if ($$e -and $$e.StartsWith($$p, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"'
  Sleep 500
  skip_preinstall_kill:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装目录的注册表键由 Tauri 模板自己写（WriteRegStr SHCTX MANUPRODUCTKEY），
  ; 这里不用重复写。重复写反而危险：写歪一个字符，下次 OTA 就找不到安装目录，
  ; 当成全新安装落到 %LOCALAPPDATA%，用户几个 GB 的运行时要重下一遍。
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 默认保留用户数据。OTA / 被动升级把 /UPDATE、/P 传给卸载器时整段跳过 ——
  ; 升级不该问用户要不要删自己的角色。
  StrCpy $KeepUserData 1
  StrCmp $UpdateMode 1 skip_uninst_kill
  StrCmp $PassiveMode 1 skip_uninst_kill

  ; 确认页勾了「同时删除用户数据」就不再问；没勾则弹窗让用户选。
  StrCmp $DeleteAppDataCheckboxState 1 uninst_force_delete_data
  IfSilent skip_uninst_prompt
    MessageBox MB_YESNO|MB_ICONQUESTION "是否保留用户数据（角色、训练产物、合成结果、设置）？$\r$\n$\r$\n选「是」将保留整个 User_Data（含训练了几小时的实验），下次安装后可继续使用。$\r$\n选「否」将连同这些一起删除。$\r$\n$\r$\n无论选哪个，下载的 Runtime 运行环境与底模都会一并清除（几个 GB）。" IDYES skip_uninst_prompt
    StrCpy $KeepUserData 0
    Goto skip_uninst_prompt
  uninst_force_delete_data:
    StrCpy $KeepUserData 0
  skip_uninst_prompt:

  ; 停掉安装目录里的进程，否则 Runtime\pythonw.exe 还攥着 DLL，
  ; 后面 RMDir 会剩半截。同样只按 $INSTDIR 前缀匹配。
  nsExec::ExecToLog 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$$p = [IO.Path]::GetFullPath(''$INSTDIR''); Get-CimInstance Win32_Process | ForEach-Object { $$e = [string]$$_.ExecutablePath; if ($$e -and $$e.StartsWith($$p, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"'
  Sleep 800
  skip_uninst_kill:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 模板已经按清单删完随包文件。这里只清事后下载/生成的残留。
  ; **不要 RMDir /r "$INSTDIR"**：用户万一装到 D:\ 这种宽目录，
  ; 递归删会把同盘别的东西一起带走。逐个点名，最后用不带 /r 的 RMDir
  ; 收尾 —— 目录空了才删，还有东西就留着。
  StrCmp $UpdateMode 1 skip_uninst_clean
  StrCmp $PassiveMode 1 skip_uninst_clean

  ; 首启补全下来的 Python 运行环境，几个 GB。
  RMDir /r "$INSTDIR\Runtime"
  RMDir /r "$INSTDIR\runtime"
  ; 底模：hubert / roberta / s1v3 / v2ProPlus 的 s2G+s2D / sv，几百 MB。
  RMDir /r "$INSTDIR\pretrained_models"
  ; 上游 japanese.py 会往这里编译日文用户词典。
  RMDir /r "$INSTDIR\TEMP"
  ; OTA 换过 frontend 之后哈希文件名和清单对不上，模板删不干净。
  RMDir /r "$INSTDIR\frontend"

  StrCmp $KeepUserData 1 skip_uninst_userdata
    RMDir /r "$INSTDIR\User_Data"
    RMDir /r "$INSTDIR\UserData"
  skip_uninst_userdata:

  Delete "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffprobe.exe"
  Delete "$INSTDIR\package_meta.json"
  RMDir "$INSTDIR"
  skip_uninst_clean:
!macroend
