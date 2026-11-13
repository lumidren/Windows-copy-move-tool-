## Flingo 0.4.0

Flick a photo off your phone and watch it land on your PC. This release teaches both apps to update themselves, so this is the last version you have to install by hand.

> [!NOTE]
> 0.4.0 works with 0.3.0 and 0.2.0 on the other side. Getting to 0.4.0 is still a manual install, because older versions have no updater: run the new installer on the PC, and on the phone uninstall Flingo, install this APK and pair again.

### New

- **Update offers.** Each app asks GitHub which release is the newest and tells you when it is not the one you have.
- **Windows updates in place.** *Update now* downloads the installer, checks it against the release's SHA-256, and *Restart and install* swaps the app and opens it again. Paired phones and settings are kept.
- **Android updates in place.** *Update* downloads the APK, checks it the same way, and hands it to Android, which asks you to confirm. The first time, Android also asks you to allow Flingo to install apps.
- **Linux is told, not changed.** The offer opens the download page, because installing a package needs your password.
- **Yours to control.** Nothing installs without a click. *Check for updates* can be switched off in both apps, *Later* hides an offer, and *Check now* asks straight away.

### A tidier look

- **The PC window has a bar of tabs down the left:** Home (pairing and what has arrived), Arrivals (the effects), Settings and About. Stage mode hides the bar and shows Home.
- **Pairing on the phone starts from a clearer choice:** scan the QR code, find the PC on the Wi-Fi, or type it in, each with a line saying when to pick it.
- **About** in both apps: the version, who made Flingo, and links to the website, GitHub, LinkedIn and the source code.

### Faster

- **The PC window stays responsive during a large batch.** A new arrival adds one tile instead of redrawing the whole list, and the list is written to disk once a second instead of once per file.
- **The phone sets up its secure connection to the PC once** and reuses it for the next file and for its regular "is the PC there" check, instead of starting from nothing every time. It also looks each file up once instead of twice.

### Changed

- The **Files** button on the phone is now **Browse files**, and outlined so it is easier to find. It opens the phone's file browser, for a large video, a document or anything else that is not in the photo grid.

### Good to know

- The update check is the only time Flingo uses the internet. It reads a public page and sends nothing about your devices or files. Everything else still works with no internet at all.
- In stage mode the PC does not check and shows no offer.
- From this release on the APK is signed with the project's own key, which is what lets one version install over another. Older APKs were signed with throwaway keys, so this one cannot install over them: uninstall the old app first.
- Android may show a Google Play Protect prompt the first time, because the app does not come from the Play Store.
- The Windows installer is not code-signed, so Windows shows a "Windows protected your PC" box when you run it by hand. Choose **More info**, then **Run anyway**.
- A copy of the PC app that was not installed with the installer (an unpacked folder) is offered the download page instead of updating itself.
- Tested on an Android emulator and a Windows PC against a stand-in release list. Updating through a real release is first possible with the release after this one.

### Downloads

| Platform | File |
|---|---|
| Android 10+ | `flingo.apk` |
| Windows 10 / 11 | `Flingo-Setup.exe` |
| Linux (Kali, Debian, Ubuntu) | `flingo-linux.deb` |
| Linux (any 64-bit distro) | `flingo-linux.tar.gz` |
