## Flingo 0.2.0

Flick a photo off your phone and watch it land on your PC. This release makes that reliable enough to show on a stage, and it encrypts every transfer.

> [!IMPORTANT]
> **Update both sides.** Flingo 0.2.0 encrypts every connection, so a 0.2.0 phone cannot talk to a 0.1.0 PC, or the other way round. Install the new version on the PC and on the phone, uninstall the old phone app first, then pair again.

### New

- **Pair by QR code.** The PC shows a code, the phone scans it, done. It works on Wi-Fi networks that stop devices from finding each other, because the code carries the PC's address.
- **Encrypted transfers.** Every connection is TLS. The PC makes its own certificate and the phone pins it when it pairs, so it will not send to anything else at that address. A short security code on both sides lets you compare them by eye.
- **Stage mode.** One switch keeps the display awake, enlarges the window, picks the Comet effect and locks pairing so nobody else can pair a phone.
- **Pre-flight check.** One button checks the receiver, the network, Windows Firewall, the paired phone, the save folder and the overlay, and runs a real test transfer.
- **Progress for big files** on the phone, in the window and on the big screen.
- **Automatic reconnection.** The phone notices when the PC goes away and finds it again by itself.
- **Choose the arrival screen** when more than one display is connected.
- **Optional landing sound** on the PC and haptic feedback on the phone.

### Better

- The arrival animation scales with the screen, from 720p to 4K at 200% scaling, and its timing no longer depends on the frame rate.
- Error messages on the phone say what happened and what to do next.
- The receiver is stricter: pairing attempts are limited, uploads are capped in size and number, free disk space is checked first, and files that could run are shown in their folder instead of being opened.
- The phone keeps Flingo's traffic on Wi-Fi even when that Wi-Fi has no internet.

### Good to know

- The Windows installer is not code-signed, so Windows shows a "Windows protected your PC" box. Choose **More info**, then **Run anyway**.
- The first time Flingo starts, allow it through Windows Firewall on **Private and Public** networks. The pre-flight check tells you if it is blocked.
- Pairing by typing the address and code trusts the certificate it sees the first time. Pairing by QR code is the fully pinned path.
- Photos in JPEG or PNG animate as the picture itself. Videos, HEIC photos and other files arrive intact but show a file card.
- Planning to show Flingo live? Read the [demo runbook](https://github.com/lumidren/Windows-copy-move-tool-/blob/main/DEMO.md), which also lists what has and has not been tested on real hardware.

### Downloads

| Platform | File |
|---|---|
| Android 10+ | `flingo.apk` |
| Windows 10 / 11 | `Flingo-Setup.exe` |
| Linux (Kali, Debian, Ubuntu) | `flingo-linux.deb` |
| Linux (any 64-bit distro) | `flingo-linux.tar.gz` |
