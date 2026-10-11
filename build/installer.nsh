; Prism V2 installer hooks (electron-builder NSIS include).
;
; customInit runs before the files are written. An old Prism V2 still running would keep
; files locked and would keep answering on the web port after the new build lands — the app
; quits itself before starting the installer, so everything stopped here is a leftover: a
; second install, an instance started by a stale autostart, an old build from a previous
; update. This is the Windows half of "one Prism per machine"; the Linux and headless sides
; live in desktop/instances.js and the updater.
!macro customInit
  nsExec::ExecToLog 'taskkill /f /im "Prism V2.exe" /t'
  nsExec::ExecToLog 'taskkill /f /im "prism-v2.exe" /t'
!macroend

; After the install, a startup shortcut that points at a Prism V2.exe which no longer exists
; is removed, so a dead autostart from an older install cannot try to launch nothing. The app
; rewrites its own startup shortcut (and clears the old registry entry) on the next start.
!macro customInstall
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=Join-Path $env:APPDATA ''Microsoft\Windows\Start Menu\Programs\Startup''; Get-ChildItem -Path $s -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $p=(New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath; if ($p -like ''*Prism V2*'' -and -not (Test-Path $p)) { Remove-Item -LiteralPath $_.FullName -Force } }"'
!macroend
