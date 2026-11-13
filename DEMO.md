# Flingo live demo runbook

A photo leaves a phone and lands on the big screen. It takes two seconds and it has to work the first time. This page is the plan for making sure it does, and for what to do if it doesn't.

Everything below assumes Flingo **0.2.0 or newer on both the PC and the phone**. A 0.1.0 phone cannot talk to a 0.2.0 PC, because 0.2.0 encrypts every connection.

> [!IMPORTANT]
> Three things in this runbook have **not** been tested on real hardware by the project and must be proven in your own rehearsal: scanning the QR code with a real phone camera, running over a phone hotspot, and showing arrivals on a second screen in "Extend" mode. Each has a fallback listed here. Do the rehearsal with the exact laptop, phone, cable and adapter you will carry on stage.

## The one rule

**Bring your own network.** Conference Wi-Fi commonly stops devices from talking to each other, and nothing on the laptop can fix that. Flingo only needs the phone and the PC to reach each other, not the internet, so a private network you control removes the largest single risk.

| Network plan | How | Notes |
|---|---|---|
| **A. Your own hotspot (recommended)** | A second phone or a travel router makes a Wi-Fi network. The stage laptop and the demo phone both join it. | Nobody else is on it. Give it a password. Internet is not needed. |
| **B. The demo phone's own hotspot** | Turn on the hotspot on the demo phone and join it from the laptop. | One device fewer. Pair with the QR code after joining. |
| **C. Venue Wi-Fi** | Only if you tested it in the room, on the day. | If "Find my PC on this Wi-Fi" finds nothing, the QR code may still work. If the QR code also cannot connect, the network isolates devices: go to A or B. |

Whichever you choose, **pair with the QR code**. It carries the PC's address and its encryption fingerprint, so it does not depend on the network letting devices discover each other.

## What to carry

- Stage laptop, charger, and the video adapter for the venue's projector
- Demo phone, charged, with 6 to 10 good-looking photos at the top of its gallery
- **A second phone, already paired**, in your pocket (Plan B for a dead or misbehaving phone)
- Your hotspot device and its charger
- The two demo videos saved locally on the laptop (`docs/video/what-is-flingo.mp4` and `how-it-works.mp4`), open in a player and paused (Plan C)

## The night before (30 minutes)

Do this on the real stage laptop, on the real hotspot.

1. **Install Flingo on the laptop and start it once.**
   - Windows shows a blue "Windows protected your PC" box for the installer because it is not code-signed. Choose **More info**, then **Run anyway**. This happens once, tonight, not on stage.
   - The first time Flingo starts, Windows Firewall asks about it. Tick **both Private and Public** and choose **Allow**. If you miss it, pre-flight will tell you.
2. **Install Flingo on both phones.** Allow access to photos, and to the camera when it asks (the camera is only used to scan the pairing code).
3. **Join the hotspot** from the laptop and from both phones.
4. **Pair each phone.** On the phone: **Pair with PC**, then **Scan the QR code**, and point it at the code in the Flingo window. Click the QR code on the laptop to enlarge it if the phone struggles.
   - If the camera will not scan: choose **Type the PC's address and code** and copy the address and the six digits shown next to the QR code.
5. **Check the security code matches.** Tap the PC's name at the top of the phone app. The security code shown there must be the same as the one under "Pair a phone" on the laptop.
6. **Turn on Stage mode** (top right of the Flingo window). It keeps the laptop's display awake, makes the window readable from a distance, selects the Comet effect, and **locks pairing** so nobody in the audience can pair their own phone.
7. **Set the arrival screen.** Connect the projector or a second monitor.
   - Simplest and recommended: set Windows to **Duplicate** (Win+P). The audience sees what you see and there is nothing to choose.
   - If you must use **Extend**: under "Arrival effect" pick the audience's screen in **Show arrivals on**. Press **Identify** to see which number is which. Then press **Play a test arrival** and confirm the audience screen shows it.
8. **Windows settings that can ruin a demo:**
   - Turn on **Do not disturb** (notification centre, or Settings → System → Notifications).
   - Plug in the charger. Set the power mode to **Best performance**.
   - Pause Windows Update for a week. Close chat apps, mail and anything that pops up.
   - Turn off the screen saver and any "dim the display" setting. Stage mode holds the display awake, but not a lid close.
9. **Run the Pre-flight check** (top of the Flingo window) with the phone open on Flingo. Every line must be green except the one that reminds you about notifications. A test photo flies across the arrival screen as part of the check.
10. **Rehearse the whole script three times**, including picking the phone up from the table and unlocking it.
11. **Rehearse the failures once each:** switch the hotspot off and on again and watch the phone reconnect by itself; close and reopen Flingo on the laptop; flick from the second phone.

Remove any phone under "Paired phones" that you will not be using. Every paired phone can send to the screen.
