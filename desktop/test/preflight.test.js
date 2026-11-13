// Pre-flight logic tests: the firewall verdict and the checklist as a whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { runPreflight, judgeFirewall } = require('../src/preflight');

const on = (...names) => ['Domain', 'Private', 'Public'].map((name) => ({ name, enabled: names.includes(name) ? 'True' : 'False' }));

test('firewall verdicts', () => {
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on(), rules: [] }).state, 'off');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [] }).state, 'none');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Private' }] }).state, 'none',
    'allowed on Private only does not help on a Public network');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Private, Public' }] }).state, 'allowed');
  assert.equal(judgeFirewall({ categories: ['Private'], profiles: on('Private'), rules: [{ action: 'Allow', profile: 'Any' }] }).state, 'allowed');
  assert.equal(judgeFirewall({ categories: ['Public'], profiles: on('Public'), rules: [{ action: 'Allow', profile: 'Any' }, { action: 'Block', profile: 'Public' }] }).state, 'blocked',
    'a block rule wins over an allow rule');
  assert.equal(judgeFirewall({ categories: 'DomainAuthenticated', profiles: on('Domain'), rules: { action: 'Allow', profile: 'Domain' } }).state, 'allowed',
    'single values arrive unwrapped from PowerShell');
  assert.equal(judgeFirewall({ categories: [], profiles: on('Public'), rules: [] }).state, 'unknown');
});
