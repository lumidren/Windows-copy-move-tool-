# Accessibility in Flingo

The target is WCAG 2.2 level AA, on every screen of both apps. This page says what was
changed, what was checked and how, and what was not checked. All of it was done on
2026-11-14, on the code now on `main`.

Short version: both apps can be used without the flick, without a mouse, and without sight
of the progress bar; text and controls meet the contrast AA asks for; and nothing has to
move. It has **not** been tried by a person who relies on a screen reader, and it has not
been run on a real phone.

## Using Flingo without the gesture

The flick is the heart of Flingo and it is not the only way to do anything.

| To do this | Without the flick |
|---|---|
| Send one photo so that it flies in on the PC | Tap it, press **Send**. Or, with a screen reader: *double-tap and hold*, which TalkBack announces as "send to your PC". Or, with a keyboard: hold Enter on it. |
| Send several photos | Tap each one (or "N selected" to take a whole day), press **Send**. |
| Send any other file | **Browse files**, or share to Flingo from another app. |
| Send from the PC | **Send to phone** button, or right-click a file in Explorer, **Send to**, **Phone (Flingo)**. Dragging onto the window is an extra, not the only way. |
| Take a received file out of the PC window | Enter opens it; the menu key (or Shift+F10) shows it in its folder. Dragging the tile out is an extra. |

One thing changed for everybody because of this: **Send** with a single photo selected now
sends it the way a flick does, so it flies in on the PC. Several photos still arrive quietly
as a batch.

## What changed

### PC window

- **Contrast.** Filled buttons had light text on the accent colour at 2.7:1; they now have
  dark text at 6.2:1. Fields, selects and switches had outlines at 1.3:1 against the panel;
  they are now 3.3:1 or better. Effect names sit on their own dark patch, because one of the
  effect pictures is bright orange where the name is.
- **Keyboard.** Every control is reached with Tab in reading order and shows a 3-pixel ring
  that stands off from the control, so it is seen against the panel whatever colour the
  control is. The QR code is a button: Enter fills the window with it, Escape puts it back.
- **Screen reader.** Switches are announced as switches, progress bars as progress bars, and
  check marks have words as well as a shape and a colour. Progress is not read out as it
  moves: a batch of 30 photos changed its card about 95 times and produced two spoken sentences,
  "Receiving 30 files" and "30 files received, from Pixel 8 · 19 MB". A lost connection or a
  failure interrupts; everything else waits its turn.
- **Time.** A card about something that went wrong stays until it is dismissed, instead of
  disappearing after six seconds. (In stage mode it still clears itself, because nobody is at
  the keyboard.)
- **Zoom.** At 200% zoom in the smallest window the layout becomes one column that scrolls
  down, with nothing cut off and no sideways scrolling.
- **High contrast.** Windows' high-contrast themes replace every colour; the switches, bars,
  dots and marks that were drawn with a background alone now use the theme's own colours.
- **Movement.** A new **Movement** setting under Arrivals: follow this PC's setting, always
  reduced, or always full. Reduced stops every animation in the window, and on the arrival
  screen the photo fades in where it would have come to rest, stays as long, and fades out.
  Nothing flies, spins, bursts or pulses.

### Phone app

- **Send without the flick**, as in the table above. A long-press that comes from a screen
  reader, a switch or a keyboard used to start a drag that could never be finished, and the
  next tap could send the photo by accident. It now sends the photo.
- **Every control is a button to assistive technology.** They were pieces of text with a tap
  on them, so TalkBack never said "button" and Switch Access and Voice Access had no role to
  go on.
- **Every photo says which one it is**: "Photo 3 of 61, Nov 14, 6:17 PM", with its row and
  column, instead of every tile saying only "Photo".
- **48 dp targets.** The connection chip, Browse files, Update, the update's close button,
  Cancel on the status pill, the About links, Check now, the check boxes and the text fields
  were between 32 and 46 dp.
- **Contrast.** White on the accent colour was 3.1:1 on "Pair with PC", Update, Send and the
  QR badge; they now use dark text at 6.2:1. Android's own dialogs were grey with accent
  buttons at 3.3:1; they now use Flingo's dark panel at 5.6:1. The play mark on a video and
  the words in the send zone sit on a dark patch. Quiet buttons have an outline.
- **Not colour alone.** Connected is a full green dot; not reachable is an amber *ring*. The
  two colours are almost equally bright.
- **Spoken progress.** Nothing was said between pressing Send and the result. Now the start,
  each quarter, a lost connection, its return and the final check are said, with a pause
  between any two. When the size was unknown it was the other way round: the byte count was
  read out ten times a second. That is gone.
- **Time to read.** Messages on the status pill stay for as long as Android's "Time to take
  action" setting asks.
- **Large text and display size.** Rows that sat side by side stack when text is large;
  Settings scrolls; marks such as ✕ keep the size of the box they sit in.
- **Rotation.** The app was locked upright. It now turns with the phone, as does the QR
  scanner, without restarting or losing what was selected.
- **Typing the address and code.** Each field has a name above it, and a mistake is shown on
  the field it is in while the dialog stays open, instead of in a message behind a dialog
  that had closed and reopened empty.
- **Movement.** A **Reduce motion** setting, and Android's own "Remove animations" is
  honoured: an arriving photo appears where it would have come to rest instead of dropping in
  and turning, and a sent photo fades instead of flying off.

## What was checked, and how

### By tests that run on every push

- **PC, 22 tests** (`desktop/test/a11y.test.js`): the contrast of every text, outline and
  mark colour, worked out from the stylesheet's own values; that every button has words and
  every field a label; that switches have the switch role; that the list of progress cards is
  not a live region and the announcer is; that nothing removes the focus ring.
- **PC arrival screen** (`npm run test:overlay`, ten screen sizes): with reduced movement the
  photo is in its resting place from the first moment, and nothing of the effect is drawn.
  The test fails if the photo is allowed to fly; that was tried.
- **Phone, 17 unit tests**: the contrast of the palette, including text over the brightest
  and darkest photo, and the rule for when progress is spoken.

### Keyboard only, on the PC window

Driven through the DevTools protocol with real key events, on the real window.

| Page | Controls reached by Tab | Not reached | No focus ring | Smaller than 24 px |
|---|---|---|---|---|
| Home | 48 (11 controls and 37 received files) | 0 | 0 | 0 |
| Phones | 19 | 0 | 0 | 0 |
| Arrivals | 15 | 0 | 0 | 0 |
| Settings | 13 | 0 | 0 | 0 |
| About | 11 | 0 | 0 | 0 |

Done with keys alone: opening a page with Enter and with Space; flipping a switch and
flipping it back; changing Movement with the arrow keys; enlarging the QR code and closing
it with Escape, with focus still on it afterwards; opening "Other ways to pair" and reaching
the two buttons inside it.

Also on the real window: at 380 points wide (200% zoom in the smallest window) no page
scrolls sideways; with the system asking for less movement no element has a running
animation or a transition, and "Full" overrides that; a high-contrast theme, looked at in
a screenshot.

### The phone app, on an Android emulator (API 37)

Every screen was read back from Android's accessibility tree and each tappable thing checked
for a role, words and a size of at least 48 by 48 dp.

| Screen | Tappable things | Problems |
|---|---|---|
| Main screen | 21 | 0 |
| Main screen with a photo selected | 21 | 0 |
| Select menu | 4 rows and Cancel | 0 |
| Settings | 6 | 0 |
| About | 5 | 0 |
| The PC's dialog | 3 | 0 |
| Pair with your PC | 4 | 0 |
| Type the PC's details | 2 fields, 2 buttons | 0 |
| Main screen, text at 200% on the largest display size (320 dp wide) | 18 | 0 |
| Settings at that size, scrolled to its end | all reachable | 0 |
| Main screen turned sideways | 20 | 0 |

**With TalkBack switched on**, what it actually said was captured from its own
"display speech output" setting:

- "Home-PC, connected. Button"
- "Photo 1 of 61, Nov 14, 6:17 PM. Row 1. Column 1. In grid. 21 rows. 3 columns"
- "Double-tap to select. Double-tap and hold to send to your PC"
- after selecting a photo: "1 selected. Button"
- after a hold with no finger: "Sending", and then the result, such as "Sent 2 files to
  Home-PC"
- after a used pairing code: "That QR code has already been used. The PC is showing a new
  one: scan it again."

Also on the emulator: a photo reached with Tab (white focus ring) and sent by holding Enter;
the same flick with a finger, three times, still works; with animations switched off in
Android an arriving photo appears upright in place; rotating keeps the selection and the
same process; an empty address shows "Enter the PC's address" on that field with the dialog
still open. After all of it, 60 photos were sent each way and compared by SHA-256: identical.

## What was not checked

- **No person who uses a screen reader, a switch or voice control has tried it.** Everything
  above is what the tools report and what TalkBack displayed.
- **TalkBack's swipe gestures could not be scripted** on the emulator: Android ignores
  injected touches while TalkBack is exploring by touch. Its speech was captured by moving
  with the keyboard, which TalkBack follows. So the order in which a finger swipe visits
  things, including the rule that puts the Send bar before the grid, is set in the code and
  not confirmed by a swipe.
- **No screen reader was run on the PC** (Narrator, NVDA, Orca). Roles, names and what the
  announcer is given were checked in the page; how each reader voices them was not.
- **The QR scanner screen** comes from a library and was not audited. Its scan line moves
  whatever the motion setting is. Pairing does not need it: "Find my PC" and "Type it in"
  avoid the camera.
- **The address and code fields** measured 45 dp tall; they were then raised to 48 dp and
  not measured again.
- **The update bar on the phone** was not on screen during this pass (it needs a newer
  release to exist). Its buttons were given the same role, size and colours in code.
- **Real devices.** No real phone, no real high-contrast theme, no Linux desktop.
- **The arrival screen itself is not announced** by a screen reader: it is a see-through,
  click-through window that never takes focus. The same news is in the main window, and with
  "Show arrivals on this PC" switched off it comes as an ordinary notification, which screen
  readers do read.
- **Languages.** Everything is in English, written in the code. A phone set to another
  language reads English text with that language's voice.
