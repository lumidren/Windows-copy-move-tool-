## Flingo 0.4.1

Flick a photo off your phone and watch it land on your PC, or send files the other way. This release fixes sending from the PC to a phone that was paired a second time, and tidies the PC window.

> [!NOTE]
> From 0.4.0, both apps update themselves: **Update** on the phone, **Update now** on Windows. Coming from 0.3.0 or older is still a manual install: run the new installer on the PC, and on the phone uninstall Flingo, install this APK and pair again.

### Fixed

- **Files sent to a phone that never came for them.** Installing Flingo again on a phone and pairing it again left the phone's old entry on the PC, under the same name. If files had been sent to that old entry before, the PC kept sending there and waited for a phone that no longer existed. Files now go to the pairing the phone uses now, the phone you have just paired is the one files go to, and a pairing that was replaced is labelled as one, with a button to remove it.

### Changed on the PC

- **The pairing code is always on Home.** Once a phone was paired, the QR code moved to the Phones tab, where a second phone or a reinstalled one had to go looking for it. It is now a smaller card beside what has arrived; click it to fill the window.
- **A cleaner sidebar.** Drawn icons instead of text symbols, and the section in view is a filled row.
- **Clearer headings,** and an empty list that says files can be dropped on the window to send them to the phone.

### Known

- If the phone's Flingo is open while the PC still runs 0.3.0, and the PC is then updated, the phone starts collecting files the next time Flingo is opened on it.
- Not yet run on a wide range of phones. If something does not work on yours, please open an issue.

Everything that arrived in 0.4.0 (PC to phone, Send from Explorer, the new scanner, accessibility, faster batches, updates in place) is described in the [0.4.0 notes](https://github.com/lumidren/Windows-copy-move-tool-/releases/tag/v0.4.0).
