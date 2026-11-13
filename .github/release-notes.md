## Flingo 0.3.0

Flick a photo off your phone and watch it land on your PC. This release is about moving a lot at once: many photos, any kind of file, and large files that do not start again when the Wi-Fi blips.

> [!NOTE]
> 0.3.0 works with 0.2.0 on the other side, but the new features need 0.3.0 on both the phone and the PC. Neither works with 0.1.0.

### New

- **Send many at once.** Tap photos to select them, or pick "Today", "The last 7 days", "The last 30 days" or "Everything", then press **Send**. They arrive quietly: the PC shows one card that counts them in, with no flight per photo.
- **Flick a stack.** With photos selected, hold and flick one of them. That one flies in; the rest follow quietly.
- **Any file.** The **Files** button opens the phone's file picker, for documents, archives and anything else that is not in the gallery.
- **Large files survive a dropped connection.** The PC keeps what arrived, the phone asks how much that was, and sends only the rest. It keeps trying for 45 seconds after the last byte got through.
- **Keeps going in the background.** A long transfer continues when you switch apps or the screen turns off. A notification shows progress, speed and time left, with a Cancel button.
- **Cancel** a long transfer from the phone at any time.
- **A queue.** Flick or send again while something is on its way and it is added behind it.

### Better

- The PC keeps the last 200 received files in its list, up from 60, and stays responsive while a large batch arrives.
- A file that is sent quietly is confirmed on the PC with a short "Received" card.
- When a large transfer is cut off, the PC says it is waiting for the phone to carry on, instead of calling it failed at once.

### Changed

- A **tap** on a photo now selects it. Holding and flicking works as before.

### Good to know

- A transfer that is carried on after a drop is not checksummed end to end. TLS protects each part in flight and the PC checks the final size.
- Files in a batch are sent one after another over separate connections, so thousands of very small files are slower than they could be.
- The Windows installer is not code-signed, so Windows shows a "Windows protected your PC" box. Choose **More info**, then **Run anyway**.
- The APK is signed with a debug key, so uninstall the old app before installing this one.

### Downloads

| Platform | File |
|---|---|
| Android 10+ | `flingo.apk` |
| Windows 10 / 11 | `Flingo-Setup.exe` |
| Linux (Kali, Debian, Ubuntu) | `flingo-linux.deb` |
| Linux (any 64-bit distro) | `flingo-linux.tar.gz` |
