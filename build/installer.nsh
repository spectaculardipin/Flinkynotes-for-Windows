; Flinkynotes NSIS custom macros (Task 11).
; Electron's setLoginItemSettings registers a per-user Run value for
; autostart ("Start with Windows"). The stock uninstaller leaves it behind,
; so a removed app would still launch at sign-in. Delete every value name
; Electron may have used on uninstall. No-op when autostart was never on.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flinkynotes"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.flinkynotes.app"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Electron"
!macroend
