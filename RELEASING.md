# Releasing Flingo

How a release is made, the one key it needs, and how to test that the apps update themselves.

## How the apps update

Both apps read GitHub's public description of the newest release:

```
https://api.github.com/repos/lumidren/Windows-copy-move-tool-/releases/latest
```

| | Looks for | Then |
|---|---|---|
| **Windows**, installed with `Flingo-Setup.exe` | `Flingo-Setup.exe` | Downloads it, checks its size and SHA-256 against the release, runs it, and quits. The installer replaces the app and starts it again. |
| **Windows**, run from an unpacked folder, and **Linux** | nothing | Opens the release page in the browser. |
| **Android** | `flingo.apk` | Downloads it, checks its size and SHA-256, compares who signed it with the installed app, and hands it to Android's installer, which asks the person to confirm. |

A download is only used when its address is under this repository's `releases/download/` and the release declares its SHA-256. A release marked as a draft or a pre-release, or whose tag is not `vX.Y.Z`, is ignored.

So a release must keep these asset names: `Flingo-Setup.exe`, `flingo.apk`, `flingo-linux.deb`, `flingo-linux.tar.gz`.

## One time: the Android signing key

Android replaces an installed app only with one signed by the **same key**. Without a key of its own, each build is signed with a debug key that exists only on the machine that built it, so no release can update the one before.

The build signs with the project's key when two repository secrets exist. Create the key once, on your own computer:

1. Make the key. It asks you to choose a password; nobody else should ever see it.

   ```bash
   keytool -genkeypair -keystore flingo-release.p12 -storetype PKCS12 -alias flingo -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Flingo"
   ```

   `keytool` comes with any JDK, including the one inside Android Studio.

2. Turn the file into text and copy it. In PowerShell:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("flingo-release.p12")) | Set-Clipboard
   ```

3. On GitHub, open the repository's **Settings → Secrets and variables → Actions → New repository secret**, and add:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the text from step 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | the password from step 1 |

4. Keep `flingo-release.p12` and its password somewhere safe and backed up, outside this repository. If they are lost, no future release can update the apps people already have; they would have to uninstall and install again.

The **android** job of every build prints the fingerprint of the key that signed the APK ("Show which key signed the APK"). It must be the same from one release to the next.

The first release signed with this key cannot install over an older, debug-signed Flingo: that one time, people uninstall the old app first. The app explains this itself when it meets an update signed with a different key.

## Making a release

1. Set the new version in three places: `desktop/package.json`, `desktop/package-lock.json` (twice, near the top), and `versionCode` / `versionName` in `android/app/build.gradle.kts`. `versionCode` must go up by at least one.
2. Rewrite `.github/release-notes.md`. It becomes the release's description.
3. Push `main`, wait for the build to pass, then tag it:

   ```bash
   git tag -a v0.4.0 -m "Flingo 0.4.0"
   ```

   ```bash
   git push origin v0.4.0
   ```

4. When the tag's build has finished, check the release has all four files and that the Android key fingerprint matches the last release.

## Testing the updater

### For real

An app can only be offered a release newer than itself, so a real test takes two releases: install version A (which has the updater), publish version B, and watch A offer B. The README's download links always give the newest one, so fetch A from its own release page.

- **Windows:** install A with `Flingo-Setup.exe`. Open Flingo and wait 20 seconds, or press **Check now** under *This PC*. Press **Update now**, then **Restart and install**. Flingo should come back as B, with its paired phones and settings intact.
- **Android:** install A's `flingo.apk`. Open Flingo; the offer appears under the hint line (or use ⚙ → **Check now**). Press **Update**, allow Flingo to install apps when Android asks, and confirm. Flingo should reopen as B, still paired.
- **Linux:** the offer's button should open the release page.

### Without publishing anything

Both apps can be pointed at a stand-in release list: any web server that answers with JSON shaped like GitHub's (`tag_name`, `assets[].name`, `size`, `digest` as `sha256:…`, `browser_download_url`).

- **PC, from source:** `FLINGO_UPDATE_FEED=http://127.0.0.1:8129/latest npm start`. Add `FLINGO_UPDATE_DRY_RUN=1` to go through download and checksum without starting an installer. Both are ignored by a packaged copy.
- **Android, on the emulator:** build with the stand-in's address baked in, and build a second APK with a higher version to serve from it:

  ```bash
  ./gradlew assembleDebug -PflingoUpdateFeed=http://10.0.2.2:8129/latest -PflingoUpdateDownloads=http://10.0.2.2:8129/files/
  ```

  ```bash
  ./gradlew assembleDebug -PflingoUpdateFeed=http://10.0.2.2:8129/latest -PflingoUpdateDownloads=http://10.0.2.2:8129/files/ -PflingoVersionCode=99 -PflingoVersionName=9.9.9
  ```

  A build made this way may use plain HTTP to `10.0.2.2` (the emulator's name for your computer) and nowhere else. Never publish one.

`npm test` covers the PC's side of this: which releases are offered, which downloads are trusted, and that a file that was changed or cut short is thrown away.
