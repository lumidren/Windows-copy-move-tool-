# Flingo

**Flick a photo off your Android phone and watch it land on your Windows PC.**

Hold a photo, flick it toward your laptop, and it flies onto the PC screen with an animated arrival, then saves to a folder. No cable, no cloud, no account: the file goes straight from the phone to the PC over your own Wi-Fi.

| | |
|---|---|
| **Windows app** | Electron tray app with a transparent, click-through arrival overlay |
| **Android app** | Native Kotlin, no UI framework, ~5 MB debug APK |
| **Transport** | Direct LAN HTTP, UDP broadcast discovery, one-time 6-digit pairing |

## How it works

```
 Android phone                               Windows PC
┌──────────────────┐   UDP broadcast :47800  ┌──────────────────────┐
│ gallery grid     │ ───"FLINGO_DISCOVER"──▶ │ discovery responder  │
│ hold + flick up  │ ◀──{id, name, port}──── │                      │
│                  │                         │                      │
│ pair (6 digits)  │ ──POST /pair──────────▶ │ checks code, issues  │
│                  │ ◀──{token}───────────── │ a 256-bit token      │
│                  │                         │                      │
│ flick!           │ ──POST /send?x=0.7────▶ │ streams to disk      │
│                  │    Bearer token, raw    │ → overlay animation  │
│                  │    file body            │ → Received list      │
└──────────────────┘                         └──────────────────────┘
```

1. **Discovery.** The phone broadcasts a small UDP datagram on every network interface's broadcast address. Any PC running Flingo answers with its name, id and port.
2. **Pairing.** The PC shows a random 6-digit code. The phone posts it once and receives a 256-bit random token. The PC stores only the token's SHA-256 hash. Each code works for one phone, then rotates; five wrong guesses from an address lock it out for a minute.
3. **Sending.** The file is streamed as the raw request body, so memory use stays flat for large videos. The PC writes to a `.part` file and renames on completion, so a dropped connection never leaves a half-written photo.
4. **Arrival.** The flick's horizontal position travels with the upload (`x=0…1`), so the photo enters the PC screen roughly where you threw it.

## The gesture

- **Hold** a photo to pick it up. It lifts off the grid and follows your finger.
- **Flick up**, or drag into the glowing **send zone** at the top of the screen, and let go.
- Let go anywhere else and it snaps back.

The send zone's size (10–50% of the screen) is adjustable in the phone's settings. A fast upward flick sends from anywhere on the screen.

Flingo is also an Android **share target**: from any app, *Share → Flingo* sends files of any type.

## Arrival effects

Chosen on the PC, each drawn on a full-screen transparent canvas that ignores mouse input so it never blocks your work:

- **Comet** – the photo streaks in with a glowing particle trail
- **Ripple** – rings spread from where it entered and where it lands
- **Confetti** – a burst when it lands
- **Aurora** – ribbons of light rise from the bottom edge

Turn off *Show arrivals on this PC* to save quietly with a notification instead.

## Run it

### Windows

Requires Node.js 20+.

```bash
cd desktop
npm install
npm start
```

To build a standalone `Flingo.exe` (creates Start menu and desktop shortcuts on first launch):

```bash
npm run package
```

The first time Flingo starts, Windows Firewall asks whether to allow it. Choose **Allow** for private networks, otherwise the phone cannot reach the PC.

### Android

Requires Android Studio (or JDK 17–21 and the Android SDK). Android 10 or newer.

```bash
cd android
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the phone and install it, or run `adb install` with the phone connected.

### Pair

1. Open Flingo on the PC. It shows a 6-digit code.
2. Open Flingo on the phone and tap **Pair with PC**.
3. Pick the PC from the list and type the code.

If the PC is not found (some routers block broadcast), tap **Enter address** and type the address shown under the code.

## Project layout

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

## Design notes

- **No dependencies in the protocol path.** The desktop server uses only Node's `http`, `dgram`, `fs` and `crypto`. The Android client uses `HttpURLConnection` and `DatagramSocket`.
- **Gesture arbitration.** A long press hands the touch stream from the scrolling `RecyclerView` to the activity (a synthetic `ACTION_CANCEL` stops the list), so scrolling and picking up never fight.
- **Address changes.** The phone remembers the PC by id, not just IP. If a send fails, it rediscovers the PC and retries once at the new address.
- **Hostile filenames.** Names are reduced to a base name, stripped of characters Windows rejects, guarded against reserved device names (`CON`, `NUL`, …) and de-duplicated with ` (1)`, ` (2)`.

## Limits

- Both devices must be on the same local network.
- Transfers are authenticated but **not encrypted**. Use it on networks you trust, such as home Wi-Fi.
- One direction only: phone to PC.

## License

MIT © lumidren
