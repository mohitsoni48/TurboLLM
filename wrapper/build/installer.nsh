; TurboLLM's NSIS include for the electron-builder Windows installer (GitHub #250, ADR-441).
;
; Why: the stock app-running check prompts before closing a running TurboLLM, and its kill can miss
; a process that still holds files under the install folder, so the install stops at "TurboLLM
; cannot be closed". This file replaces that check through electron-builder's customCheckAppRunning
; hook, in the installer and the uninstaller alike: a running TurboLLM, and anything running from
; the install folder, is always closed without asking.
;
; Bound to app-builder-lib 26.15.3 template internals: $CmdPath, $PowerShellPath,
; IS_POWERSHELL_AVAILABLE, getProcessInfo.nsh, and the LangStrings appClosing, appCannotBeClosed and
; installing. Re-verify every one of them on any electron-builder upgrade.
;
; Never define preInit, customInit or customHeader here. electron-builder EXECUTES the uninstaller
; stub on the build machine, so anything those add would run there. This file holds macros only.

!include "LogicLib.nsh"
!include "getProcessInfo.nsh"

!define TURBOLLM_POLL_MS           1000
!define TURBOLLM_GRACE_POLLS       3
!define TURBOLLM_FORCE_ATTEMPTS    3
; nsExec's /TIMEOUT waits for output and restarts whenever output arrives. The commands below print
; next to nothing before they exit, which is what keeps each call bounded in practice.
!define TURBOLLM_EXEC_TIMEOUT_MS   15000
!define TURBOLLM_INSTDIR_ENV       "TURBOLLM_SETUP_INSTDIR"

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

; Graceful first, so TurboLLM can quit through its own shutdown; forced after, for what cannot answer
; a close (no window yet, a cancelled close, a background process left under the install folder).
; ${_OUT} ends as the last probe: 1 means something still runs after the whole budget.
!macro TURBOLLM_CLOSE_ALL _OUT
  !insertmacro TURBOLLM_SIGNAL_CLOSE
  ${For} $R1 1 ${TURBOLLM_GRACE_POLLS}
    Sleep ${TURBOLLM_POLL_MS}
    !insertmacro TURBOLLM_IS_RUNNING ${_OUT}
    ${If} ${_OUT} == 0
      ${ExitFor}
    ${EndIf}
  ${Next}
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
!macroend

; The hook electron-builder inserts instead of its own check, once per compile. There is no "TurboLLM
; is running" prompt: the installer closes it itself. Retry/Cancel appears only after a whole automatic
; attempt has failed (for example a TurboLLM started as administrator), and Retry runs that whole
; attempt again. The marker is printed at compile time only, so the build log proves the insertion.
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
      ; through. The uninstaller prints nothing, as stock did: "Installing" would be wrong there.
      !ifndef BUILD_UNINSTALLER
        SetDetailsPrint textonly
        DetailPrint "$(appClosing)"
        SetDetailsPrint lastused
      !endif
      ${Do}
        !insertmacro TURBOLLM_CLOSE_ALL $R0
        ${If} $R0 == 0
          ${ExitDo}
        ${EndIf}
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
    !insertmacro TURBOLLM_CLEAR_INSTDIR
  ${EndIf}
!macroend
