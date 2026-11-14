; Explorer's "Send to" menu.
;
; Windows lists every shortcut in the SendTo folder under right-click > Send to, and starts
; the shortcut's program with the selected files on its command line. One shortcut to
; "Flingo.exe --send" is the whole integration: nothing in the registry, no shell extension.
;
; Flingo makes the same shortcut itself each time it starts, unless that is switched off in
; its Settings (syncSendToMenu in src/main.js), so the name here and the name there must match.

!macro customInstall
  CreateShortCut "$SENDTO\Phone (${PRODUCT_NAME}).lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "--send" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 SW_SHOWNORMAL "" "Send to your phone with ${PRODUCT_NAME}"
!macroend

!macro customUnInstall
  Delete "$SENDTO\Phone (${PRODUCT_NAME}).lnk"
!macroend
