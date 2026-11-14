## Flingo 0.4.0

Flick a photo off your phone and watch it land on your PC. This release teaches both apps to update themselves, so this is the last version you have to install by hand.

> [!NOTE]
> 0.4.0 works with 0.3.0 and 0.2.0 on the other side. Getting to 0.4.0 is still a manual install, because older versions have no updater: run the new installer on the PC, and on the phone uninstall Flingo, install this APK and pair again.

### New

- **PC to phone.** Flingo is two-way now. Drag files onto the Flingo window, or press **Send to phone**. Photos and videos land in the phone's Pictures/Flingo, everything else in Download/Flingo, and a notification opens what arrived. With several phones paired, pick which one gets the files.
- **Send from Explorer.** Select files in Explorer, right-click, and choose **Send to**, then **Phone (Flingo)**. They go as one batch, and Flingo starts by itself if it was not running. On Windows 11, Send to is under **Show more options**. Settings has a switch to remove the entry.
- **Nothing is lost on the way back either.** A dropped connection carries on from where it stopped, and the phone checks every file against its SHA-256 before showing it.
- **Update offers.** Each app asks GitHub which release is the newest and tells you when it is not the one you have.
- **Windows updates in place.** *Update now* downloads the installer, checks it against the release's SHA-256, and *Restart and install* swaps the app and opens it again. Paired phones and settings are kept.
- **Android updates in place.** *Update* downloads the APK, checks it the same way, and hands it to Android, which asks you to confirm. The first time, Android also asks you to allow Flingo to install apps.
- **Linux is told, not changed.** The offer opens the download page, because installing a package needs your password.
- **Yours to control.** Nothing installs without a click. *Check for updates* can be switched off in both apps, *Later* hides an offer, and *Check now* asks straight away.

### A tidier look

- **The PC window has a bar of tabs down the left:** Home, Phones, Arrivals (the effects), Settings and About.
- **Home is one thing at a time.** Before a phone is paired it shows only how to pair one, with the typed code and other details folded away under "Other ways to pair". After that it shows only what has arrived, and pairing moves to the Phones tab. Stage mode hides the tabs and shows pairing and arrivals side by side.
- **Pairing on the phone starts from a clearer choice:** scan the QR code, find the PC on the Wi-Fi, or type it in, each with a line saying when to pick it.
- **About** in both apps: the version, who made Flingo, and links to the website, GitHub, LinkedIn and the source code.

### Faster

- **Batches travel three files at a time,** in both directions, over connections that stay open between files. On the test bench 500 photos go 2.4 times faster to the PC and 2.2 times faster to the phone. How much of that you see depends on your Wi-Fi; it has not been measured on a real phone.
- **A single large file reaches the PC's disk about 1.3 times faster** on the test bench, because the PC now writes a megabyte at a time.
- **The PC window stays responsive during a large batch.** A new arrival adds one tile instead of redrawing the whole list, and the list is written to disk once a second instead of once per file.
- **The phone sets up its secure connection to the PC once** and reuses it for the next file and for its regular "is the PC there" check, instead of starting from nothing every time. It also looks each file up once instead of twice.

### Changed

- The **Files** button on the phone is now **Browse files**, and outlined so it is easier to find. It opens the phone's file browser, for a large video, a document or anything else that is not in the photo grid.

### Good to know

- Files from the PC arrive at once while Flingo is open on the phone. If it is closed, they wait on the PC and arrive when you next open it. They are lost if Flingo on the PC is closed before the phone collects them.
- **Send to** takes files, not folders, and a few hundred at a time. Appearing in the Windows Share menu and at the top of Windows 11's right-click menu needs a signed app package, which Flingo does not have yet.
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
