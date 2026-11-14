# Flingo speed measurements

What the software itself costs, measured with `npm run bench` in `desktop/`. The sender and the
receiver are two processes on the same computer, talking over TLS on the loopback address, so
these numbers are a ceiling: a real transfer is limited by the Wi-Fi link and by the phone long
before it reaches them. They exist to show where time goes and to catch a change that makes
things slower.

Machine: Intel Core i7-12700H, NVMe SSD, Windows 11, Node 24.

## Phone to PC

| Date | How the files are sent | One 1 GB file | 500 files of 3 MB |
|---|---|---|---|
| 2026-11-14, baseline | one at a time, a new connection per file (what the phone does today) | 3.3 s, 311 MB/s | 7.2 s, 209 MB/s |
| 2026-11-14, experiment | four at a time, a new connection per file | | 4.3 s, 346 MB/s |
| 2026-11-14, experiment | four at a time, connections reused | | 3.7 s, 400 MB/s |

What the baseline says:

- **The PC is not the limit.** Even one file at a time it takes over 200 MB/s. A fast home Wi-Fi
  link carries 30 to 100 MB/s.
- **Many small files leave speed on the table.** Sending four at a time and keeping connections
  open nearly doubles the batch (209 to 400 MB/s here). On a real link the gain depends on how
  much of each file's time is waiting rather than sending.
- **Not measured here:** the phone's own reading and encrypting, and real Wi-Fi. Those need a
  real phone.
