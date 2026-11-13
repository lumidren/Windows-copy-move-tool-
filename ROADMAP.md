# Flingo roadmap

Twenty features, grouped by what they improve. Size is a rough guess: **S** is a day or two, **M** about a week, **L** several weeks.

**Shipped in 0.2.0:** encrypted transfers (1), QR-code pairing (2), progress (9), and sound and haptics (14). They stay in the tables below, marked ✅, so the numbering other documents refer to does not move.

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
| 7 | **Multi-select flick** | Tap to select several photos, then flick the stack once. The PC shows them fanning out. | M |
| 8 | **Resumable large transfers** | Chunked uploads with a checksum, so a 4 GB video survives a Wi-Fi drop and continues where it stopped. | M |
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

1. **Signed releases (4)**: the last trust gap. It needs a code-signing certificate and a stable Android key.
2. **A picture for every arrival**: have the phone send a small preview with videos and HEIC photos, so they fly in as pictures instead of file cards.
3. **Multi-select (7)** and **PC to phone (6)**: the features people ask for once the basics work.
4. Everything else, in whatever order is most fun.
