// Tests for which of the PC's addresses a phone is told to try, and in what order. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { lanAddresses, linkAddresses, primaryAddress, MAX_IN_LINK } = require('../src/addresses');

const v4 = (address, mac = 'aa:bb:cc:00:00:01', internal = false) => ({ address, family: 'IPv4', mac, internal });
const v6 = (address) => ({ address, family: 'IPv6', mac: 'aa:bb:cc:00:00:01', internal: false });

// A PC like many: a cable, Wi-Fi, two virtual-machine adapters and the loopback.
const typical = {
  'Ethernet 2': [v6('fe80::1'), v4('192.168.56.20')],
  'VMware Network Adapter VMnet1': [v4('192.168.117.1', '00:50:56:c0:00:01')],
  'VMware Network Adapter VMnet8': [v4('192.168.229.1', '00:50:56:c0:00:08')],
  'Wi-Fi': [v6('fe80::2'), v4('192.168.1.11')],
  'Loopback Pseudo-Interface 1': [v4('127.0.0.1', '00:00:00:00:00:00', true)],
};

test('adapters no phone can reach are left out', () => {
  assert.deepEqual(lanAddresses(typical), ['192.168.56.20', '192.168.1.11']);
  // Recognised by its maker's hardware address even when it has an ordinary name.
  assert.deepEqual(lanAddresses({ 'Ethernet 3': [v4('192.168.56.1', '0a:00:27:00:00:10')], 'Wi-Fi': [v4('10.0.0.5')] }), ['10.0.0.5']);
  assert.deepEqual(lanAddresses({ 'vEthernet (WSL)': [v4('172.20.0.1', '00:15:5d:aa:bb:cc')], eth0: [v4('10.0.0.5')] }), ['10.0.0.5']);
});

test('the address this PC really uses goes first, so the phone does not wait on a dead one', () => {
  // Without knowing, they come in the order the system lists them: the cable first.
  assert.equal(lanAddresses(typical)[0], '192.168.56.20');
  // Knowing that Wi-Fi is the way out puts Wi-Fi first and keeps the other as a second try.
  assert.deepEqual(lanAddresses(typical, '192.168.1.11'), ['192.168.1.11', '192.168.56.20']);
});

test('a "primary" address that is not one of the reachable ones changes nothing', () => {
  assert.deepEqual(lanAddresses(typical, '192.168.117.1'), ['192.168.56.20', '192.168.1.11'], 'a virtual adapter is not promoted');
  assert.deepEqual(lanAddresses(typical, '8.8.8.8'), ['192.168.56.20', '192.168.1.11']);
  assert.deepEqual(lanAddresses(typical, ''), ['192.168.56.20', '192.168.1.11']);
});

test('no network at all is an empty list, not an error', () => {
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses(undefined), []);
  assert.deepEqual(lanAddresses({ lo: [v4('127.0.0.1', '00:00:00:00:00:00', true)] }), []);
});

test('the same address on two adapters is listed once', () => {
  assert.deepEqual(lanAddresses({ a: [v4('10.0.0.5')], b: [v4('10.0.0.5')] }), ['10.0.0.5']);
});

test('the pairing link carries a few addresses at most, and never drops the best one', () => {
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`eth${i}`, [v4(`10.0.${i}.5`)]]));
  const inLink = linkAddresses(many, '10.0.5.5');
  assert.equal(inLink.length, MAX_IN_LINK);
  assert.equal(inLink[0], '10.0.5.5');
});

test('asking which address is the way out answers with an address or with nothing, and sends nothing', async () => {
  const address = await primaryAddress();
  assert.match(address, /^$|^\d{1,3}(\.\d{1,3}){3}$/);
  assert.notEqual(address, '0.0.0.0');
});
