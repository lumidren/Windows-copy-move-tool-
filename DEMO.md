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
