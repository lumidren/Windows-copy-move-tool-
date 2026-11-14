# Flingo roadmap

Thirty-six features, grouped by what they improve. Size is a rough guess: **S** is a day or two, **M** about a week, **L** several weeks.

**Shipped in 0.2.0:** encrypted transfers (1), QR-code pairing (2), progress (9), and sound and haptics (14).
**Shipped in 0.3.0:** multi-select (7) and resumable large transfers (8), plus two things that were not on the list: a file picker for any kind of file, and transfers that keep going in the background.

**Done on `main` for 0.4.0:** PC to phone (6), with resume and a checksum on every file; batches that travel three files at a time, in both directions; a "Phone (Flingo)" entry in Explorer's Send to menu (35); accessibility to WCAG 2.2 level AA in both apps (31); both apps find and install their own updates (the second half of 20), and the build signs the APK with the project's own key (the Android half of 4; see [RELEASING.md](RELEASING.md)).

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
| 6 | ✅ **PC to phone** | Drag a file onto the Flingo window, or press Send to phone, and it lands on the phone. Makes the app two-way. Still open: flicking a tile off the bottom of the window. | L |
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

## Show-stoppers

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 21 | **Party wall** | Many phones flick onto one big screen, which fills up as a live photo wall and then plays as a slideshow. Made for events, weddings and stage demos. Pairing already handles several phones; the work is the wall layout and slideshow window. | M |
| 22 | **Camera flick** | Take a photo inside Flingo and flick it straight away, without a trip through the gallery. The send path already exists; this adds an in-app camera screen. | S |
| 23 | **Throw physics** | A harder flick flies in faster, a sideways flick spins. The phone already measures the flick; it only needs to send the speed along with the position. | S |
| 24 | **Pull from the PC** | Swipe down on the phone to grab a screenshot of the PC screen. Builds on PC to phone (6). | M |

## Smart features

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 25 | **Text from photos** | Photograph a whiteboard or a page and its text lands on the PC clipboard. On-device text recognition, so nothing leaves the network. | M |
| 26 | **Scan mode** | Crop and straighten a document photo automatically and save it on the PC as a PDF. | M |
| 27 | **Auto-convert** | Turn HEIC into JPG, shrink huge photos, and optionally strip the GPS location before sending. | S |
| 28 | **Auto-sort** | Save arrivals into folders by date or by phone, with clean file names. | S |

## Comfort and reach

| # | Feature | Why it matters | Size |
|:-:|---|---|:-:|
| 29 | **Unsend** | A few seconds to take back a flick sent by mistake: the PC moves it to the bin and the card flies back out. | S |
| 30 | **History and search** | A searchable list of everything sent and received, on both devices. | M |
| 31 | ✅ **Accessibility** | A plain Send for anyone who can't do the gesture, screen-reader labels and spoken progress everywhere, AA contrast, 48 dp targets, large text, rotation, keyboard use of the whole PC window, and a reduced-motion setting that the effects respect. Checked by tests, a keyboard-only walk and TalkBack on an emulator; not yet by a person who relies on them ([details](docs/accessibility.md)). | M |
| 32 | **Translations** | Move every string into translation files, including right-to-left layouts. | M |
| 33 | **Browser receiver** | A guest PC opens a web page and receives files with nothing installed. The phone has to act as the server, and a browser tab cannot draw over the whole screen, so the arrival is plainer. | L |
| 34 | **Phone to phone and tablets** | A tablet layout is quick. Receiving on a phone means running a server there in the background. | M |
| 35 | ✅ **Windows "Send to" menu** | Right-click files in Explorer, **Send to**, **Phone (Flingo)**: one batch, whether Flingo was running or not. Added by the installer, removed by the uninstaller, and switchable in Settings. Still open: the Windows Share menu and the top level of Windows 11's right-click menu, which need a signed package ([the plan](#the-windows-share-menu-what-it-takes)). | M |
| 36 | **Flick into an app** | Drop zones on the PC screen: flick to the left edge for a chosen folder, to the right to open the photo in a chosen app. | M |

## The Windows Share menu: what it takes

Not built. Written down so the cost is known before anyone starts.

**Why it is not just another shortcut.** The Send to menu lists whatever shortcuts are in a
folder, so one shortcut was enough. The Share menu (and the top level of Windows 11's new
right-click menu, which today hides Send to under "Show more options") only lists apps that
Windows knows by a *package identity*. Flingo is installed by an ordinary installer and has
none.

**What gives an app an identity.** Either of two things, both described in Microsoft's
documentation:

1. Shipping Flingo as an **MSIX package**, through the Microsoft Store or as a download.
2. Keeping today's installer and adding a small identity-only package beside it, which
   Microsoft calls a *sparse package* or *packaging with external location*. Windows 10
   version 2004 or later.

**What both of them need, and Flingo lacks: a signature Windows trusts.** A package only
registers if it is signed by a certificate the PC already trusts. That means a code-signing
certificate (paid, renewed every year or so), or the Microsoft Store signing it for us. A
self-made certificate works only on PCs where someone has installed it by hand as an
administrator, which is not something to ask of a stranger. This is the same certificate the
Windows half of signed releases (4) is waiting for, so the two should be done together.

**The work, once there is a certificate.**

- A package manifest that declares Flingo as a *share target* for files, and as a command in
  File Explorer's right-click menu.
- A small native piece, because Windows hands a share to the app through an activation that
  Electron does not expose: it reads what was shared and starts `Flingo.exe --send` with the
  files. The receiving end of that is already built and tested, for the Send to menu.
- Shared things that are not files (a link, a piece of text, a picture copied from a web
  page) have to be written to a file first, or refused with a clear message.
- The installer registers the package and the uninstaller removes it; the release build signs
  it. Both in CI.
- Tested by hand on Windows 10 and on Windows 11, since the two draw these menus differently.

**Rough size:** M, about a week, most of it packaging and testing rather than code.

**Recommendation.** Take the second route, so the installer and the built-in updater stay as
they are, and do it in the same release as Windows code signing. Until then the Send to
entry is the way in, and it works on both Windows 10 and 11.

## Suggested order

1. **Signed releases (4)**: the last trust gap. The Android half is built and signs with the project's key. The Windows half needs a code-signing certificate, and the same certificate opens the door to the Windows Share menu (35).
2. **A picture for every arrival**: have the phone send a small preview with videos and HEIC photos, so they fly in as pictures instead of file cards.
3. **PC to phone (6)**: done on `main`. Next for it: delivery while Flingo is closed on the phone, and flicking a tile out of the window.
4. **Faster batches**: done on `main`. Three files of a batch travel at once over connections that stay open, in both directions ([measurements](docs/benchmarks.md)). Still unmeasured on a real phone.
5. Everything else, in whatever order is most fun.
