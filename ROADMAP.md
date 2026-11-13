# Flingo roadmap

Twenty features, grouped by what they improve. Size is a rough guess: **S** is a day or two, **M** about a week, **L** several weeks.

**Shipped in 0.2.0:** encrypted transfers (1), QR-code pairing (2), progress (9), and sound and haptics (14).
**Shipped in 0.3.0:** multi-select (7) and resumable large transfers (8), plus two things that were not on the list: a file picker for any kind of file, and transfers that keep going in the background.

**Done on `main` for 0.4.0:** both apps find and install their own updates (the second half of 20), and the build signs the APK with a stable key once that key is added (the Android half of 4; see [RELEASING.md](RELEASING.md)).

Finished items stay in the tables below, marked ✅, so the numbering other documents refer to does not move.

## Security and trust

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 1 | ✅ **Encrypted transfers** | Run the channel over TLS with a certificate pinned at pairing time, so nobody on the Wi-Fi can read or alter a file in flight. Closes the biggest gap with LocalSend and Quick Share. | M |
| 2 | ✅ **QR-code pairing** | The PC shows a QR code holding its address, port and a one-time secret. Scanning replaces typing six digits and works even when discovery is blocked. | S |
| 3 | **Confirm before saving** | Optional "Accept / Decline" on the PC for each arrival, with an auto-accept list of trusted phones. | S |
| 4 | **Signed releases** | Sign the APK with a stable key and the Windows installer with a code-signing certificate, so updates install over old versions and SmartScreen stops warning. | S |
| 5 | **Per-phone permissions** | Give each paired phone its own save folder and size cap, and see when it last sent something. | S |

## Transfer

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 6 | **PC to phone** | Drag a file onto the Flingo window, or flick it off the bottom of the screen, and it lands on the phone. Makes the app two-way. | L |
| 7 | ✅ **Multi-select** | Tap to select several photos, or a whole day at once, then press Send or flick the stack. The PC counts them in on one card instead of playing a flight for each. Still open: showing a flicked stack fanning out. | M |
| 8 | ✅ **Resumable large transfers** | A large file survives a Wi-Fi drop: the PC keeps what arrived and the phone sends only the rest. Still open: a checksum of the whole file. | M |
| 9 | ✅ **Progress and speed** | A progress ring on the phone and on the arrival card for anything larger than a few megabytes. | S |
| 10 | **Clipboard and links** | Share text or a URL to Flingo and it lands on the PC clipboard, or opens in the browser. | S |
| 11 | **Wi-Fi Direct fallback** | When there is no shared network (a café, a hotspot), connect the two devices directly. | L |

## Experience

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 12 | **Aim at a screen** | With several monitors or several PCs, tilt the phone left or right while flicking to choose where the photo lands. | M |
| 13 | **More effects and an effect kit** | Add effects (Origami, Polaroid drop, Portal) and document a tiny plug-in format so anyone can write one in a single JS file. | M |
| 14 | ✅ **Sound and haptics** | A soft whoosh on send, a click on landing, and matching vibration on the phone. Off by default. | S |
| 15 | **Drop where you want** | After landing, the photo stays as a draggable card for a few seconds so it can be dropped straight into a chat, document or folder. | M |
| 16 | **Albums and search on the phone** | Browse by album, filter by photos or videos, and search by date, instead of one long grid. | M |
| 17 | **Auto-send new photos** | An opt-in mode that sends each new camera photo to the PC as it is taken. Useful for product photos and document scanning. | M |

## Platforms and distribution

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 18 | **macOS and iOS apps** | The desktop app already runs on Electron, so macOS is mostly packaging. iOS needs a native app and a share extension. | L |
| 19 | **Native Wayland overlay** | Use the layer-shell protocol for the arrival overlay on GNOME and KDE Wayland instead of relying on XWayland. | M |
| 20 | **Store listings and auto-update** | Publish to F-Droid, Google Play, winget and Flathub, and let the desktop app update itself. | M |

## Suggested order

1. **Signed releases (4)**: the last trust gap. The Android half is built and waits for the key to be added to the repository's secrets. The Windows half needs a code-signing certificate.
2. **A picture for every arrival**: have the phone send a small preview with videos and HEIC photos, so they fly in as pictures instead of file cards.
3. **PC to phone (6)**: the feature people ask for once the basics work.
4. **Faster batches**: send several small files over one connection, or a few at a time, instead of one after another.
5. Everything else, in whatever order is most fun.
