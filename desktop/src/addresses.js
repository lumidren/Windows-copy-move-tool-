// Which of this PC's addresses a phone should try, and in what order.
//
// A PC often has several: Wi-Fi, a cable, and adapters made by VPNs and virtual machines
// that no phone can reach. The pairing QR code carries the list, and a phone that tries a
// dead address first loses a couple of seconds finding out. So the address this PC actually
// uses to reach the network goes first.
//
// No Electron in here, so it runs under `node --test`.
const dgram = require('dgram');

// Virtual adapters (VM hosts, WSL, VPNs) are never the address a phone can reach.
const VIRTUAL_NAME = /vmware|virtualbox|vethernet|hyper-v|wsl|docker|loopback|tailscale|zerotier/i;
// VirtualBox, VMware and Hyper-V host adapters, by MAC vendor prefix.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d)/i;
const MAX_IN_LINK = 3; // more addresses make a denser QR code that is slower to scan

/**
 * The IPv4 addresses a phone could reach, from what os.networkInterfaces() returns.
 * `primary`, if it is one of them, comes first.
 */
function lanAddresses(interfaces, primary = '') {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !VIRTUAL_MAC.test(a.mac || '') && !out.includes(a.address)) out.push(a.address);
    }
  }
  if (primary && out.includes(primary)) return [primary, ...out.filter((a) => a !== primary)];
  return out;
}

/** The addresses that go into the pairing link: the best first, and no more than fit a QR code that scans easily. */
function linkAddresses(interfaces, primary = '') {
  return lanAddresses(interfaces, primary).slice(0, MAX_IN_LINK);
}

/**
 * Resolves to the address this PC sends from when it talks to the outside world, or '' if it
 * has no route out (a hotspot with no internet, a cable between two machines). Nothing is
 * sent: pointing a UDP socket at an address only makes the system choose the adapter. The
 * address pointed at is one reserved for documentation, which belongs to nobody.
 */
function primaryAddress() {
  return new Promise((resolve) => {
    let socket;
    const done = (address) => { try { socket.close(); } catch { /* already closed */ } resolve(address); };
    try {
      socket = dgram.createSocket('udp4');
      socket.on('error', () => done(''));
      socket.connect(9, '192.0.2.1', () => {
        let address = '';
        try { address = socket.address().address; } catch { /* no route */ }
        done(address === '0.0.0.0' ? '' : address);
      });
    } catch { resolve(''); }
  });
}

module.exports = { lanAddresses, linkAddresses, primaryAddress, MAX_IN_LINK };
