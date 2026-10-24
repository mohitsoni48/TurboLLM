; TurboLLM's NSIS include for the electron-builder Windows installer (GitHub #250, ADR-441).
;
; Why: the stock app-running check prompts before closing a running TurboLLM, and its kill can miss
; a process that still holds files under the install folder, so the install stops at "TurboLLM
; cannot be closed". This file replaces that check through electron-builder's customCheckAppRunning
; hook, in the installer and the uninstaller alike: a running TurboLLM, and anything running from
; the install folder (that part needs PowerShell), is closed without asking first. A Retry/Cancel
; message appears only if that fails.
;
; Bound to app-builder-lib 26.15.3 template internals: $CmdPath, $PowerShellPath,
; IS_POWERSHELL_AVAILABLE and its $IsPowerShellAvailable (0 = available), getProcessInfo.nsh, the
; defines APP_EXECUTABLE_FILENAME and BUILD_UNINSTALLER, and the LangStrings appClosing,
; appCannotBeClosed and installing. Re-verify every one of them on any electron-builder upgrade.
;
; Never define preInit, customInit or customHeader here. electron-builder EXECUTES the uninstaller
; stub on the build machine, so anything those add would run there. This file holds macros only.

!include "LogicLib.nsh"
!include "getProcessInfo.nsh"

!define TURBOLLM_POLL_MS           1000
!define TURBOLLM_GRACE_POLLS       3
!define TURBOLLM_FORCE_ATTEMPTS    3
!define TURBOLLM_SETTLE_POLLS      2
!define TURBOLLM_AUTO_RETRY_ATTEMPTS    5
!define TURBOLLM_AUTO_RETRY_BACKOFF_MS  3000
; rd prints nothing while it deletes, so its idle timeout has to cover deleting the whole
; node_modules tree - tens of thousands of files.
!define TURBOLLM_CLEAR_TIMEOUT_MS  180000
; nsExec's /TIMEOUT waits for output and restarts whenever output arrives. The commands below print
; next to nothing before they exit, which is what keeps each call bounded in practice.
!define TURBOLLM_EXEC_TIMEOUT_MS   15000
; The two PowerShell commands below spell this name literally: rename all three together, or the
; install-folder check silently reads "not running".
!define TURBOLLM_INSTDIR_ENV       "TURBOLLM_SETUP_INSTDIR"

; The probe and close macros below rely on what customCheckAppRunning sets up first: it declares and
; fills $turbollmSelfPid, runs IS_POWERSHELL_AVAILABLE and exports the install folder. Without those
; the install-folder check silently reads "not running".

; The install folder reaches PowerShell through the environment instead of being inlined into the
; command, so an apostrophe in the path cannot break the path probe.
!macro TURBOLLM_EXPORT_INSTDIR
  System::Call 'Kernel32::SetEnvironmentVariable(t "${TURBOLLM_INSTDIR_ENV}", t "$INSTDIR") i'
!macroend

!macro TURBOLLM_CLEAR_INSTDIR
  System::Call 'Kernel32::SetEnvironmentVariable(t "${TURBOLLM_INSTDIR_ENV}", p 0) i'
!macroend

; ${_OUT} becomes 1 when a TurboLLM.exe of this user runs, or when any process other than this one
; runs from the install folder. Only exit code 0 counts, compared as text (==), so the "error" and
; "timeout" results of nsExec never read as running: a broken probe must not become a false "cannot
; be closed". The length guard keeps an empty or drive-root install folder from ever being swept.
!macro TURBOLLM_IS_RUNNING _OUT
  StrCpy ${_OUT} 0
  nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R2
  ${If} $R2 == 0
    StrCpy ${_OUT} 1
  ${EndIf}
  StrLen $R2 "$INSTDIR"
  ${If} $IsPowerShellAvailable == 0
  ${AndIf} $R2 > 3
    nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$PowerShellPath" -NoProfile -NonInteractive -Command "try { $$d = $$env:TURBOLLM_SETUP_INSTDIR.TrimEnd('\') + '\'; $$n = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $turbollmSelfPid -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }).Count; if ($$n -gt 0) { exit 0 } else { exit 1 } } catch { exit 2 }"`
    Pop $R2
    ${If} $R2 == 0
      StrCpy ${_OUT} 1
    ${EndIf}
  ${EndIf}
!macroend

; The exit code is ignored: a process without a window answers that it can only be ended forcefully.
!macro TURBOLLM_SIGNAL_CLOSE
  nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" /FI "PID ne $turbollmSelfPid"`
  Pop $R2
!macroend

; Forced end of this user's TurboLLM.exe and of every process whose image is under the install
; folder: the daemon and its helpers hold files there too. No tree kill: it would also end programs
; the user started from TurboLLM's terminal. The guard and the process filter are the same as in
; TURBOLLM_IS_RUNNING: change both together. Exit codes are ignored; the next probe decides.
!macro TURBOLLM_FORCE_CLOSE
  nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" /FI "PID ne $turbollmSelfPid"`
  Pop $R2
  StrLen $R2 "$INSTDIR"
  ${If} $IsPowerShellAvailable == 0
  ${AndIf} $R2 > 3
    nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$PowerShellPath" -NoProfile -NonInteractive -Command "try { $$d = $$env:TURBOLLM_SETUP_INSTDIR.TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $turbollmSelfPid -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } } catch { exit 2 }"`
    Pop $R2
  ${EndIf}
!macroend

; A process can drop out of the tasklist/WMI probe a moment before Windows actually finishes
; releasing its file handles (a lagging antivirus scan, a driver's own teardown), so the step that
; runs right after this one - the previous version's own uninstaller, or this installer's file copy -
; can still hit a locked file even though TURBOLLM_IS_RUNNING just reported nothing running. This
; requires TURBOLLM_SETTLE_POLLS consecutive clean probes, a full poll interval apart, before the
; caller trusts ${_OUT} == 0; a probe that flips back to running is treated like a fresh failure.
!macro TURBOLLM_SETTLE _OUT
  ${For} $R1 1 ${TURBOLLM_SETTLE_POLLS}
    Sleep ${TURBOLLM_POLL_MS}
    !insertmacro TURBOLLM_IS_RUNNING ${_OUT}
    ${If} ${_OUT} == 1
      ${ExitFor}
    ${EndIf}
  ${Next}
!macroend

; Called only when something runs. The installer closes gracefully first, then forces what cannot
; answer a close (no window yet, a cancelled close, a background process left under the install
; folder). A close lets TurboLLM quit through its own shutdown only when it has no tray icon: with
; one, the close just hides the window to the tray (main.js), so TurboLLM is forced after the grace
; polls and its quit handler, which ends the daemon's tree, does not run. The uninstaller forces at
; once: a graceful quit lets electron-updater start a downloaded update's installer, which would
; then run next to this uninstaller (only the installer holds the one-instance mutex). A forced end
; runs no quit handler. ${_OUT} ends as the last probe: 1 means something still runs after the whole
; budget, including one bounded extra force-close if settling turns up something the close loops
; missed.
!macro TURBOLLM_CLOSE_ALL _OUT
  StrCpy ${_OUT} 1
  !ifndef BUILD_UNINSTALLER
    !insertmacro TURBOLLM_SIGNAL_CLOSE
    ${For} $R1 1 ${TURBOLLM_GRACE_POLLS}
      Sleep ${TURBOLLM_POLL_MS}
      !insertmacro TURBOLLM_IS_RUNNING ${_OUT}
      ${If} ${_OUT} == 0
        ${ExitFor}
      ${EndIf}
    ${Next}
  !endif
  ${If} ${_OUT} == 1
    ${For} $R1 1 ${TURBOLLM_FORCE_ATTEMPTS}
      !insertmacro TURBOLLM_FORCE_CLOSE
      Sleep ${TURBOLLM_POLL_MS}
      !insertmacro TURBOLLM_IS_RUNNING ${_OUT}
      ${If} ${_OUT} == 0
        ${ExitFor}
      ${EndIf}
    ${Next}
  ${EndIf}
  ${If} ${_OUT} == 0
    !insertmacro TURBOLLM_SETTLE ${_OUT}
    ${If} ${_OUT} == 1
      !insertmacro TURBOLLM_FORCE_CLOSE
      Sleep ${TURBOLLM_POLL_MS}
      !insertmacro TURBOLLM_IS_RUNNING ${_OUT}
    ${EndIf}
  ${EndIf}
!macroend

; A single TURBOLLM_CLOSE_ALL budget (a few seconds) can lose to something slower than a normal
; shutdown - a real-time antivirus scan of the freshly-written files, a slow-releasing GPU/driver
; handle, Explorer or an indexer briefly opening a new executable. Retrying the whole
; close-then-settle cycle several times with a real backoff clears most of those automatically,
; well before anyone would need to look at a dialog. A manual Retry click gets this same full
; budget, not a single quick attempt, since it calls this wrapper too (customCheckAppRunning below).
!macro TURBOLLM_CLOSE_ALL_WITH_RETRIES _OUT
  ${For} $R3 1 ${TURBOLLM_AUTO_RETRY_ATTEMPTS}
    !insertmacro TURBOLLM_CLOSE_ALL ${_OUT}
    ${If} ${_OUT} == 0
      ${ExitFor}
    ${EndIf}
    Sleep ${TURBOLLM_AUTO_RETRY_BACKOFF_MS}
  ${Next}
!macroend

; If the whole automatic retry budget still failed, drop a plain diagnostic log naming what is
; running at that moment, so a stuck close can be read from a log instead of guessed at. Written
; only on the way to the Retry/Cancel dialog, so the common case - nothing ever gets stuck - never
; touches disk. The first dump needs only cmd.exe and always runs: a diagnostic gated on the same
; PowerShell-availability check the real probe depends on could stay silent for exactly the case
; most worth seeing. A second, path-aware dump runs only when PowerShell is available, since it can
; see what TURBOLLM_IS_RUNNING's install-folder probe sees and a plain tasklist cannot. Plain
; English, not a LangString: a technical artifact for debugging, not translated UI text, so it
; carries none of -WX's 26-language cost. Best-effort throughout: every error is swallowed or
; ignored, since a broken diagnostic must never be the reason an install fails.
!macro TURBOLLM_WRITE_DIAGNOSTIC
  nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$CmdPath" /C echo TurboLLM installer: still detected as running after the automatic retry budget >> "%TEMP%\TurboLLM-installer-diagnostic.log"`
  Pop $R2
  nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$CmdPath" /C tasklist /V >> "%TEMP%\TurboLLM-installer-diagnostic.log"`
  Pop $R2
  ${If} $IsPowerShellAvailable == 0
    nsExec::Exec /TIMEOUT=${TURBOLLM_EXEC_TIMEOUT_MS} `"$PowerShellPath" -NoProfile -NonInteractive -Command "try { $$d = $$env:TURBOLLM_SETUP_INSTDIR.TrimEnd('\') + '\'; $$log = @('install-folder probe:'); Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and $$_.ProcessId -ne $turbollmSelfPid -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $$log += '  under install folder: pid=' + $$_.ProcessId + ' path=' + $$_.ExecutablePath + ' cmd=' + $$_.CommandLine }; if ($$log.Count -eq 1) { $$log += '  (nothing found under the install folder)' }; $$log -join [Environment]::NewLine | Out-File -FilePath ($$env:TEMP + '\TurboLLM-installer-diagnostic.log') -Append -Encoding utf8 } catch {}"`
    Pop $R2
  ${EndIf}
!macroend

; electron-builder's stock uninstallOldVersion (installUtil.nsh, not overridable) cleans up the
; previous version by running that version's own uninstaller, which first renames every file into
; its own %TEMP%\nsXXXX.tmp\old-install folder. Rename, like every NSIS file call, stops at MAX_PATH
; (260 characters), and the daemon's node_modules holds files whose rename target is longer than
; that. The rename fails on the same file every time, the old uninstaller puts everything back and
; exits non-zero, and after five tries the install stops at "TurboLLM cannot be closed" - with
; nothing running and nothing locked, so Retry can never help. That uninstaller is already on the
; user's disk and cannot be changed, so this deletes the daemon tree first through a \\?\ path,
; which rd follows past MAX_PATH; the files this install copies in replace it. Guarded on
; TurboLLM.exe being present, so a mistyped or shared install folder is never touched.
!macro TURBOLLM_CLEAR_LONG_PATHS
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$INSTDIR\resources\daemon\*.*"
    nsExec::Exec /TIMEOUT=${TURBOLLM_CLEAR_TIMEOUT_MS} `"$CmdPath" /C rd /s /q "\\?\$INSTDIR\resources\daemon"`
    Pop $R2
  ${EndIf}
!macroend

; The hook electron-builder inserts instead of its own check, once per compile. There is no "TurboLLM
; is running" prompt: the installer closes it itself. Retry/Cancel appears only after the whole
; automatic retry budget has failed (for example a TurboLLM started as administrator), and Retry
; runs that whole budget again. The marker is printed at compile time only, so the build log proves
; the insertion.
!macro customCheckAppRunning
  !verbose push
  !verbose 4
  !echo "TURBOLLM: customCheckAppRunning inserted"
  !verbose pop

  Var /GLOBAL turbollmSelfPid
  ${GetProcessInfo} 0 $turbollmSelfPid $1 $2 $3 $4
  ${If} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro TURBOLLM_EXPORT_INSTDIR
    !insertmacro TURBOLLM_IS_RUNNING $R0
    ${If} $R0 == 1
      ; The install section runs under SetDetailsPrint none, so the status line has to be forced
      ; through. The uninstaller prints no status here: "Installing" would be wrong there.
      !ifndef BUILD_UNINSTALLER
        SetDetailsPrint textonly
        DetailPrint "$(appClosing)"
        SetDetailsPrint lastused
      !endif
      ${Do}
        !insertmacro TURBOLLM_CLOSE_ALL_WITH_RETRIES $R0
        ${If} $R0 == 0
          ${ExitDo}
        ${EndIf}
        !insertmacro TURBOLLM_WRITE_DIAGNOSTIC
        ${IfNot} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY`
          Quit
        ${EndIf}
      ${Loop}
      !ifndef BUILD_UNINSTALLER
        SetDetailsPrint textonly
        DetailPrint "$(installing)"
        SetDetailsPrint lastused
      !endif
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      !insertmacro TURBOLLM_CLEAR_LONG_PATHS
    !endif
    !insertmacro TURBOLLM_CLEAR_INSTDIR
  ${EndIf}
!macroend
