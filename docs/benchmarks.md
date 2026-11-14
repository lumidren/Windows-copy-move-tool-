# Flingo speed measurements

Two kinds of measurement, and what each one can and cannot tell you.

1. **`npm run bench`** in `desktop/`: a stand-in phone and the real PC receiver as two processes
   on one computer, talking over TLS on the loopback address. It shows what the PC software
   costs and catches a change that makes it slower. It says nothing about Wi-Fi or the phone.
2. **The real Android app on an emulator**, sending to and collecting from the real PC app.
   This runs the phone's actual code, but the emulator's network is slow and odd, so the
   seconds are only good for comparing before with after.

**Not measured: a real phone on real Wi-Fi.** That is the number that matters to you, and it
needs a real phone. Treat everything below as evidence that the software got out of the way,
not as a promise of megabytes per second in your living room.

Machine: Intel Core i7-12700H, NVMe SSD, Windows 11, Node 24. All figures 2026-11-14, each the
middle one of three or four runs.

## 1. Loopback benchmark

| | One 1 GB file | 500 photos of 3 MB |
|---|---|---|
| **Phone to PC, before** (one file at a time, a new connection each) | 3.3 s, 311 MB/s | 7.3 s, 204 MB/s |
| **Phone to PC, after** (three at a time, connections kept) | 2.5 s, 407 MB/s | 3.1 s, 481 MB/s |
| | **1.3 times faster** | **2.4 times faster** |
| **PC to phone, before** (one file at a time, a new connection each) | 3.2 s, 320 MB/s | 8.6 s, 174 MB/s |
| **PC to phone, after** (three at a time, connections kept) | 3.4 s, 304 MB/s | 3.8 s, 392 MB/s |
| | no change | **2.2 times faster** |

"Before" is the code at commit `793ebc4`. Reproduce the two rows of each pair with:

```
npm run bench
npm run bench -- --big=0 --parallel=3 --keepalive
```

The PC side alone, still sending one file at a time, went from 204 to about 258 MB/s on the
photo batch; the rest of the gain is the three connections.

## 2. The real phone app, on an emulator

60 photos, 38 MB in all, Android emulator (API 37) on the same computer.

| | Before | After | |
|---|---|---|---|
| Phone to PC | 48.3 s | 22.4 s | 2.2 times faster |
| PC to phone | 70.6 s | 12.3 s | 5.7 times faster |

Every file was compared by SHA-256 with its original after each run. The emulator makes each
new connection very expensive, which is why keeping connections open helps so much there. On a
real network a new connection costs less, so expect a smaller gain than this table shows.

## What changed

- **Three files of a batch travel at once**, in both directions, each on its own connection.
  The moment one file spends waiting for the other side's answer is spent sending the next.
  A flicked photo still goes first and alone, so it is the one that flies in, and the last
  file of a batch goes last, so the PC knows the batch is over.
- **Connections stay open between files of a batch** instead of being closed and made again.
  That saves the handshake, and a connection that has been carrying data is already at full
  speed, where a new one feels its way up.
- **The PC writes to disk a megabyte at a time** instead of 16 KB. This is the 1.3 times on a
  single large file.
- **Progress is reported about ten times a second** however many files are in flight.

## What was checked and left alone

- **Encryption.** The phone and the PC settle on TLS 1.3 with AES-128-GCM (seen in the
  handshake from the Android emulator), which phones and PCs run in hardware. Putting a
  different cipher first made no measurable difference, so the defaults stay.
- **Wi-Fi sleeping.** The phone already holds a high-performance Wi-Fi lock and a wake lock for
  the length of a long transfer, in both directions. Nothing to add.
- **Asking the disk for free space once a second instead of once per file.** No measurable
  difference, so it was not kept.
- **Packing many tiny files into one stream.** Not built. With connections kept open and three
  files in flight, the per-file cost is already small, and a packed stream would make
  carrying on after a dropped connection harder to get right.

## Limits

- A single large file is not split across connections, so it gains only what the PC side
  gained. On Wi-Fi its speed is the link's speed.
- Three is a fixed number. A PC running Flingo 0.3 takes at most four files at once, and one
  place is left spare for a second try.
