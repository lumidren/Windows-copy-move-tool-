<p align="center">
  <img src="docs/banner.png" alt="Flingo: flick a photo off your phone, watch it land on your PC" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-2f6fed?logo=windows11&logoColor=white" alt="Windows 10 and 11">
  <img src="https://img.shields.io/badge/Linux-Kali%20%7C%20Debian%20%7C%20Ubuntu-f5c211?logo=linux&logoColor=black" alt="Linux: Kali, Debian, Ubuntu">
  <img src="https://img.shields.io/badge/Android-10%2B-3ddc84?logo=android&logoColor=white" alt="Android 10 or newer">
  <img src="https://img.shields.io/badge/Electron-33-47848f?logo=electron&logoColor=white" alt="Electron 33">
  <img src="https://img.shields.io/badge/Kotlin-2.0-7f52ff?logo=kotlin&logoColor=white" alt="Kotlin 2.0">
  <img src="https://img.shields.io/badge/cloud-none-0e1016" alt="No cloud">
  <img src="https://img.shields.io/badge/license-MIT-9b6bff" alt="MIT license">
</p>

<p align="center">
  <b>Hold a photo. Flick it toward your laptop. It flies onto the screen and saves.</b><br>
  No cable, no cloud, no account. The file goes straight from the phone to the PC over your own Wi-Fi.
</p>

<p align="center">
  <img src="docs/hero.gif" alt="A photo arriving on the Windows desktop with the Comet effect" width="720">
</p>

<p align="center">
  <a href="https://lumidren.github.io/Windows-copy-move-tool-/"><b>Website and downloads</b></a>
  &nbsp;·&nbsp;
  <a href="https://lumidren.github.io/Windows-copy-move-tool-/#videos"><b>Watch the videos</b></a>
  &nbsp;·&nbsp;
  <a href="ROADMAP.md"><b>Roadmap</b></a>
</p>

<table>
<tr>
<td width="50%" align="center">
  <a href="https://lumidren.github.io/Windows-copy-move-tool-/video/what-is-flingo.mp4"><img src="docs/video/what-is-flingo.jpg" alt="Video: What is Flingo?" width="100%"></a><br>
  <sub>▶ <b>What is Flingo?</b> (37 s)</sub>
</td>
<td width="50%" align="center">
  <a href="https://lumidren.github.io/Windows-copy-move-tool-/video/how-it-works.mp4"><img src="docs/video/how-it-works.jpg" alt="Video: How it works" width="100%"></a><br>
  <sub>▶ <b>How it works</b> (41 s)</sub>
</td>
</tr>
</table>

---

## What you get

<table>
<tr>
<td width="50%" align="center" valign="top">
  <img src="docs/phone.png" alt="Flingo on Android: the photo grid, paired with Home-PC" width="270"><br>
  <b>Your gallery</b><br>
  <sub>Paired once, ready every time you open it.</sub>
</td>
<td width="50%" align="center" valign="top">
  <img src="docs/phone-drag.png" alt="A photo lifted off the grid and dragged into the glowing send zone" width="270"><br>
  <b>Hold, then flick</b><br>
  <sub>The photo lifts and follows your finger. The top of the screen lights up as the send zone.</sub>
</td>
</tr>
<tr>
<td colspan="2" align="center">
  <img src="docs/window.png" alt="Flingo on Windows: pairing code, effect picker and received photos" width="88%"><br>
  <b>On the PC</b><br>
  <sub>Pairing code, effect picker, and everything you've received. Drag any tile into another app.</sub>
</td>
</tr>
</table>

| | Windows app | Android app |
|---|---|---|
| **Built with** | Electron, plain HTML/CSS/canvas | Native Kotlin, Android Views |
| **Runs as** | Tray app with a real window and Start menu shortcut | Regular app + system share target |
| **Size** | Standalone `Flingo.exe` | ~5 MB APK |

## Arrival effects

Each arrival plays on a full-screen transparent layer that ignores the mouse, so it never blocks what you're doing. Pick one on the PC:

<p align="center">
  <img src="docs/effects.png" alt="The four arrival effects: Comet, Ripple, Confetti and Aurora" width="100%">
</p>

| Effect | What happens |
|---|---|
| **Comet** | The photo streaks in with a glowing particle trail |
| **Ripple** | Rings spread from where it entered and where it lands |
| **Confetti** | A burst when it lands |
| **Aurora** | Ribbons of light rise from the bottom edge |

Prefer silence? Turn off *Show arrivals on this PC* and files save quietly with a notification.

## The gesture

| Step | On the phone |
|:-:|---|
| **1** | **Hold** a photo. It lifts off the grid and follows your finger. |
| **2** | **Flick up**, or drag it into the glowing send zone at the top. |
| **3** | **Let go.** It leaves the top of the phone and enters the bottom of the PC screen, roughly where you threw it. |

Let go anywhere else and the photo snaps back. The send zone covers the top 10–50% of the screen (adjustable), and a fast upward flick sends from anywhere.

Flingo is also a **share target**: from any app, *Share → Flingo* sends files of any type.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant P as Android phone
    participant W as Windows PC

    Note over P,W: Discovery
    P-->>W: UDP broadcast :47800 "FLINGO_DISCOVER"
    W-->>P: { id, name, port }

    Note over P,W: Pairing (once)
    W->>W: show random 6-digit code
    P->>W: POST /pair { code, deviceName }
    W->>P: 256-bit token (PC keeps only its SHA-256)

    Note over P,W: Every flick
    P->>W: POST /send?x=0.62 (Bearer token, raw file body)
    W->>W: stream to .part file, rename when complete
    W->>P: 200 OK
    W->>W: play arrival effect, add to Received
```

- **Discovery.** The phone broadcasts one small UDP datagram on each network interface. Any PC running Flingo answers with its name and port.
- **Pairing.** The PC shows a random 6-digit code. Each code works for one phone, then rotates. Five wrong guesses from one address lock it out for a minute.
- **Sending.** The file is streamed as the raw request body, so memory stays flat even for long videos. A dropped connection never leaves a half-written file.
- **Arrival.** The flick's horizontal position travels with the upload, so the photo enters the PC screen where you aimed it.

## Run it

### Windows

Requires Node.js 20+.

```bash
cd desktop
npm install
npm start
```

Build a standalone `Flingo.exe` (adds Start menu and desktop shortcuts on first launch):

```bash
npm run package
```

> [!IMPORTANT]
> The first time Flingo starts, Windows Firewall asks whether to allow it. Choose **Allow** for private networks, or the phone cannot reach the PC.

### Android

Requires Android Studio, or JDK 17–21 with the Android SDK. Runs on Android 10 or newer.

```bash
cd android
./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the phone and install it.

### Pair

1. Open Flingo on the PC. It shows a 6-digit code.
2. Open Flingo on the phone and tap **Pair with PC**.
3. Pick the PC from the list and type the code.

> [!TIP]
> Some routers block broadcast. If the PC isn't listed, tap **Enter address** and type the address shown under the code.

## Under the hood

```
desktop/
  src/server.js     UDP discovery + HTTP API (pair, send), filename sanitising
  src/main.js       tray, windows, settings, pairing state
  src/overlay.js    canvas arrival animation and the four effects
  src/index.*       main window: code, effects, received list
android/
  app/src/main/java/com/lumidren/flingo/
    Net.kt          discovery, pairing, streaming upload, address recovery
    Gallery.kt      MediaStore query, thumbnail cache, grid adapter
    MainActivity.kt hold-and-flick gesture, pairing dialogs, share target
    Prefs.kt        stored pairing and settings
```

| Problem | How Flingo handles it |
|---|---|
| **Scrolling vs. picking up** | A long press hands the touch stream from the scrolling list to the activity (a synthetic `ACTION_CANCEL` stops the list), so the two never fight. |
| **The PC's IP changes** | The phone remembers the PC by id, not just address. If a send fails it rediscovers the PC and retries once. |
| **Hostile filenames** | Names are cut to a base name, stripped of characters Windows rejects, guarded against device names like `CON` and `NUL`, and de-duplicated with ` (1)`, ` (2)`. |
| **Virtual network adapters** | VirtualBox, VMware, Hyper-V and WSL adapters are hidden, so the address shown is one a phone can actually reach. |
| **Protocol dependencies** | None. The PC uses Node's `http`, `dgram`, `fs`, `crypto`; the phone uses `HttpURLConnection` and `DatagramSocket`. |

## Limits

- Both devices must be on the same local network.
- Transfers are authenticated but **not encrypted**. Use it on networks you trust, such as home Wi-Fi.
- One direction only: phone to PC.

<sub>The screenshots and animation above are real captures from the running apps. The landscape pictures in them are generated sample images, not anyone's photos.</sub>

## License

MIT © lumidren
