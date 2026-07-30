; Explorer context-menu verbs for Claude Explorer.
;
; HKCU\Software\Classes, never HKCR directly: nsis.perMachine is false, so the
; installer runs unelevated per-user and a write to HKCR\Directory\shell\...
; would need admin. HKCU\Software\Classes is merged into HKEY_CLASSES_ROOT for
; this user, so a per-user verb works with no admin rights and no elevation
; prompt.
;
; %V, not %1: for Directory\shell both expand to the folder, but for
; Directory\Background\shell only %V yields the folder that was right-clicked.
; One spelling for both is one fewer way to get it wrong.
;
; ponytail: legacy shell verb, so on Windows 11 22H2+ this lands in the "Show
; more options" (Shift+F10) submenu, not the compact top-level menu. Top-level
; placement requires an MSIX/sparse package with an IExplorerCommand COM
; handler — a different packaging story entirely. Upgrade there if it matters.
;
; ponytail: one verb, "Open in Claude Explorer" -> --open. A second "Start a
; Claude session here" -> --new-session is six more WriteRegStr lines plus a
; matching DeleteRegKey; both verbs open a files tab, the second one just says
; what you came to do. Add it when asked.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeExplorer" "" "Open in Claude Explorer"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeExplorer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeExplorer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeExplorer" "" "Open in Claude Explorer"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeExplorer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeExplorer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open "%V"'
!macroend

!macro customUnInstall
  ; DeleteRegKey (recursive) rather than DeleteRegValue, so the \command subkey
  ; goes too. Runs as the same user, so the HKCU deletion needs no elevation.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeExplorer"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeExplorer"
!macroend
