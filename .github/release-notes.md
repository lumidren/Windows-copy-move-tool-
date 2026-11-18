## Flingo 0.5.0

Flick a photo off your phone and watch it land on your PC, or send files the other way. This release is about being safe to hand to other people: both apps were reviewed for security and tightened, and both got a clearer look.

> [!NOTE]
> Both apps update themselves from 0.4.0 on: **Update** on the phone, **Update now** on Windows. 0.5.0 works with 0.4.x on the other side, with one difference you will see: a 0.5.0 phone shows a 16-character security code and a 0.4.x PC shows only the first eight. Coming from 0.3.0 or older is a manual install: run the new installer on the PC, and on the phone uninstall Flingo, install this APK and pair again.

### Security

What is protected, how it was checked and what is still open is written up in [docs/security.md](https://github.com/lumidren/Windows-copy-move-tool-/blob/main/docs/security.md).

- **Typing the code asks "Is this your PC?" first.** *Find my PC* and *Type it in* used to send the six digits to whatever computer answered. The phone now shows that computer's security code for you to compare with the one in Flingo on the PC, and sends the code only after a yes. Scanning the QR code needs no such step and is still the quickest way.
- **The pairing code cannot be guessed in bursts.** Attempts are counted as they arrive, only a few are checked at once, and if wrong codes keep coming the PC locks pairing and tells you.
- **A pairing is never silent.** The PC shows a notification naming the phone, with the way to remove it.
- **A click opens only what is safe to open.** Pictures, video, sound and documents to read open. Anything that could run is shown in its folder instead. A name can no longer end in a dot or a space to hide what it is, and on Windows received files carry the mark a browser gives a download.
- **Pairing links are strict.** A link must name the PC's certificate and an address on the local network, and one that comes from another app says plainly what it would replace.
- **The Android app is a release build,** not a debuggable one. The key is the same, so it installs over 0.4.x.
- **A current Electron.** The PC app moves from Electron 33, which no longer got security fixes, to Electron 45, and the installed program is locked down: it cannot be run as plain Node, ignores debugging switches, and loads only its own checked code.
- **The PC's private key is encrypted** with your Windows account's own protection instead of sitting in a file in the clear. Paired phones stay paired.
- **Unpair on the phone tells the PC,** so the phone's access ends there too. A pairing code on screen lasts ten minutes at most.
- **Files pushed into Flingo by another app** without permission to read them are sent only after asking. Files shared from the gallery or the file manager still go straight away.
- **Smaller things:** TLS 1.3 only; a PC found by "Find my PC" is trusted only after it proves who it is; every transfer card belongs to the phone that sent it; the arrival screen on the PC can no longer reach anything but the pictures it is given; one phone cannot take every upload place or fill the disk with half-sent files; idle and stalled connections are closed; removing a phone stops its transfers at once; the phone never opens an app package it received.

### On the PC

- **A place to send from.** Home opens with a strip that says where files for the phone go, with **Choose files**. Dropping files anywhere on the window still works.
- **Received files by day.** Today, Yesterday, then the date, in larger tiles. The list scrolls inside its card, so the pairing code stays in view.
- **A quieter top bar.** It says how things stand and nothing else. **Stage mode** and the **Pre-flight check** are in Settings; while stage mode is on, the bar has the check and **Leave stage mode**.
- **Settings and Arrivals in groups,** one setting to a line with its switch at the end.

### On the phone

- **Received.** A button on the main screen lists what the PC sent, newest first, with a picture, the size and how long ago. A tap opens it.
- **Settings in Flingo's own look:** three groups, with switches.
- **Files arrive after the PC is updated** without reopening the app. The phone used to stop asking a PC that was too old to send.

### Known

- The Windows installer is not code-signed, so Windows shows its usual warning for a new program.
- Not yet run on a wide range of phones. If something does not work on yours, please open an issue.
