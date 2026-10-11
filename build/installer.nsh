; Prism V2 installer hooks (electron-builder NSIS include).
;
; customInit runs before the files are written. An old Prism V2 still running would keep
; files locked and would keep answering on the web port after the new build lands — the app
; quits itself before starting the installer, so everything stopped here is a leftover: a
; second install, an instance started by a stale autostart, an old build from a previous
; update. This is the Windows half of "one Prism per machine"; the Linux and headless sides
; live in desktop/instances.js and the updater, and the app itself rewrites its startup
; shortcut (and clears the old registry entry) on the next start.
!macro customInit
  nsExec::ExecToLog 'taskkill /f /im "Prism V2.exe" /t'
  nsExec::ExecToLog 'taskkill /f /im "prism-v2.exe" /t'
!macroend
