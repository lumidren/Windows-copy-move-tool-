# Security

What Flingo protects, how, what was checked, and what it does not do yet. Written for 0.5.0, after a review of both apps against the people who could plausibly be on the other side.

## Who Flingo defends against

| Who | What they can do | What stops them |
|---|---|---|
| **Someone on the same Wi-Fi who is not paired** | See that Flingo is running, and try to pair. | They can reach only `/info` and `/pair`. Everything else answers 401 before a byte of a body is read. |
| **Someone on the Wi-Fi pretending to be your PC** | Answer the phone's search with your PC's name. | The phone sends nothing to a computer whose certificate it has not checked: by the QR code, or by a security code you compare. |
| **A paired phone that turns hostile** | Send files with misleading names, fill the disk, hold connections. | Names are made safe, a click only opens kinds of file that are looked at or read, uploads and half-received files are capped per phone. |
| **A PC a phone was tricked into pairing with** | Send the phone files. | Files go through MediaStore into two fixed folders, are checked against their SHA-256, and Flingo never opens an app package. |
| **Another app on the phone** | Send Flingo a pairing link or share files into it. | A link must carry the PC's certificate and point at the local network, is shown by address, and asks first. |
| **A tampered update** | Replace the download. | Both apps accept only this project's release, of the declared size and SHA-256; Android also requires the same signing key. |

## Pairing

- The PC shows a six-digit code and a QR code. The QR code also carries the SHA-256 of the PC's certificate, so a phone that scans it pins that certificate before it says anything.
- **Guess limits.** Five attempts per address per minute, counted the moment a request arrives (before 0.5.0 a burst sent together slipped past the count). Three codes are checked at a time. Twelve wrong codes from anyone replace the code. The third replacement in ten minutes locks pairing until you open it again, and tells you so. That leaves about 36 guesses in a million each time you unlock.
- **Never silent.** Every pairing shows a notification naming the phone and where to remove it.
- **Short-lived.** A code is used once, and one that has been on screen for ten minutes is replaced, so a photo of the screen goes stale.
- **Typing the code.** "Find my PC" and "Type it in" used to send the six digits to whatever answered. A name or an address proves nothing on a shared network, so the phone now shows the answering computer's **security code** (16 characters of its certificate's fingerprint) and asks you to compare it with the one in Flingo on the PC. The code is sent only after a yes, and only to that certificate.
- **Pairing links.** A `flingo://pair` link must contain the certificate fingerprint and a private or link-local IPv4 address. Names, internet addresses and the phone's own address are refused. A link that arrives from another app is shown by its address (not by the name inside it), says which pairing it would replace, and cannot be answered through another app's window drawn on top.
- The token a phone gets is 256 random bits. The PC keeps only its SHA-256. Removing a phone takes effect at once: its transfers stop and what was waiting for it is taken back.
- **Unpairing from either side.** **Unpair** on the phone first asks the PC to forget it (`POST /unpair`), so its token stops working there too, and says whether the PC could be told.
- **Finding the PC again.** When the PC's address changes, the phone looks for it on the network. An answer is only a claim, so an address is kept only after the PC there has shown the pinned certificate and accepted the phone's token.

## The connection

- TLS 1.3 only, with a P-256 certificate the PC makes itself. There is no certificate authority involved, and none is needed: the phone accepts exactly one certificate, the one it pinned.
- A fingerprint that is present but cannot be read is a refusal, never "accept anything".
- The PC never falls back to plain HTTP. If its certificate cannot be saved to disk, it makes one for that run.
- **The PC's private key is encrypted at rest** with the system's protection for the user: on Windows the user's own encryption (DPAPI), which no other account and no copy of the file on another PC can undo; on Linux the desktop keyring when there is one. A key an earlier Flingo saved in the clear is converted the first time it is read, keeping the same certificate.
- The phone refuses cleartext traffic entirely.

## Files arriving on the PC

- **Names.** Reduced to a base name; characters Windows rejects, control characters, zero-width and direction-override characters are removed; every kind of space becomes a plain one; no name can end in a dot or a space (Windows would drop them and `photo.exe.` would become `photo.exe`); device names such as `CON`, `NUL`, `COM1`, `CONIN$` are prefixed.
- **Opening.** A click opens pictures, video, sound and documents meant to be read. Anything else is shown in its folder instead. The list says what is allowed, because a list of dangerous extensions is never complete.
- **Mark of the web.** On Windows each saved file gets the `Zone.Identifier` mark a browser gives a download, so Windows asks before running it and Office opens it in Protected View.
- **Limits.** 32 GB per file, free space checked up front (and again as it grows when the size was not declared), twelve uploads at once of which one phone may hold eight, eight half-received files kept per phone, thirty seconds without data ends a transfer.
- **Connections.** A request that opens and says nothing is dropped after ten seconds, idle connections close, and there is a ceiling on how many are open.

## Files arriving on the phone

- Written through MediaStore into `Pictures/Flingo` or `Download/Flingo` only. Hidden until complete and until their SHA-256 matches what the PC promised.
- Invisible and direction-changing characters are removed from names.
- Flingo never opens an app package, from the Received list or from the notification: that would start an install under Flingo's own permission to install its updates.
- Files shared into Flingo by another app are accepted as content only, never as a file path. An app that shares without giving Flingo permission to read what it shares (the gallery and the file manager do give it) would have Flingo read those files with its own access to the photos; Flingo asks before sending them.
- The pairing is excluded from cloud backup and from device-to-device transfer.

## The PC app itself

- **Electron 45**, a version that still receives security fixes, pinned exactly.
- **Fuses set in the installed program:** it cannot be run as plain Node, ignores `NODE_OPTIONS` and inspector switches, and loads its code only from its own archive and checks that archive's integrity. CI reads these back from both builds, starts the installed Windows program, checks that its receiver answers over TLS 1.3 and refuses TLS 1.2, and checks that its window drew Flingo's page with no access to Node.
- Both windows are sandboxed with context isolation and no Node. Pages get no permissions, cannot navigate and cannot open windows.
- The arrival screen, which decodes pictures a phone sent, has its own preload with two messages in and one out. It cannot read settings, pick files or send anything.
- The main window hands over dropped files, never paths: where a file is on disk is resolved in the preload, so page code cannot ask for a file nobody dropped. Requests are accepted from the main window only.
- No `innerHTML` anywhere; a strict Content-Security-Policy; external links are a fixed list.
- Every transfer card is filed under the phone that sent it, so one phone cannot move, finish or cancel another's card.
- Debugging switches work only when Flingo is run from source. Windows' own programs are started by full path.

## Updates and the build

- Both apps read this repository's release list over HTTPS and accept a download only from its releases, with the size and SHA-256 the release declares. Nothing installs without a click.
- The Android app additionally checks the package name, that the version is newer, and that the APK is signed with the key the installed app was signed with.
- From 0.5.0 the Android app is a release build, not a debuggable one. CI checks that.
- In CI, actions are named by commit, the workflow can only read the repository except in the job that publishes, and the signing key is fetched only for a release. A release without the key fails instead of publishing an APK that could never be updated.
- Gradle is checked against its published SHA-256 before it runs; the wrapper in the repository matches the published one.

## How it was checked

- An independent read of both code bases against the table above, then a fix and a test for each finding that was fixed.
- 129 automated tests on the PC (`npm test`), including the key kept encrypted and converted from the clear, a phone unpairing itself, and a burst of sixty guesses of which at most five are even read, pairing locking after sustained guessing, a request that stalls, the per-phone upload limit, removal stopping a transfer, names built to hide an extension, the allowlist for opening, and the download mark on Windows.
- 40 unit tests on the phone, including pairing links without a fingerprint, with internet addresses, with names, and with invisible characters.
- Run for real on Electron 45: a packaged copy with the same fuses as the installer, its window and pre-flight check; with the strictest `file://` fuse also tried, which blanks the packaged window and is therefore left on (see Known limits). Two phones sending batches with the same name at once, each file credited to the right phone. A profile with a key in the clear converted on start, same certificate before and after. On the emulator: a share pushed in without permission asks first and sends nothing; a share with permission goes straight through; Unpair removes the phone on the PC at once. Earlier: a file dropped on the window as Explorer drops it, a disguised `.exe` upload (saved as `holiday.exe` and shown in its folder), the pre-flight check through the restricted arrival screen, and on the emulator with the release build: a link without a fingerprint refused, typed pairing asking first with the same code on both screens and nothing sent before the answer, and files both ways with matching checksums.

## Known limits

These are real and not yet fixed. They are listed so nobody has to find them.

1. **The Windows installer and its updates are not signed.** The updater trusts GitHub's release and its checksum, so someone able to publish a release in this repository could ship anything. Closing this needs a signing key that is kept off GitHub; see ROADMAP item 39.
2. **Comparing the security code is up to you** on the typed-code paths. Scanning the QR code needs no comparison and is the recommended way.
3. **Anyone on the Wi-Fi can learn** that Flingo is running, the PC's name and its certificate fingerprint. None of these is secret.
4. **The phone keeps its pairing in the app's private storage,** which Android protects from other apps but which is not separately encrypted.
5. **The window's page is loaded from `file://`.** Electron can take away the extra rights such pages have, but Flingo's page then cannot load from inside its own archive (tried: the window stays blank), so that fuse is left on. Serving the page and the thumbnails through a custom protocol would allow it to be turned off.
6. **Linux without a keyring** (no GNOME Keyring or KWallet) keeps the PC's private key as before, readable by the same user, because the only alternative there is a fixed password that would only pretend.
7. No outside audit. The review was done in the course of development, by the same project.

## Reporting a problem

Open an issue on GitHub. If the details should not be public yet, say only that you have found a security problem and how to reach you.
