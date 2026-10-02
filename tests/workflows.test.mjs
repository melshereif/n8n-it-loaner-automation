// Structural + behavioral checks on the GENERATED workflow files (run scripts/build.mjs first).
// Each Code node is executed with a minimal stand-in for n8n's $input / $() / $now, so the exact
// JavaScript that ships in the JSON is exercised, not just the logic module.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`../workflows/${f}`, import.meta.url), 'utf8'));
const files = ['1-request.json', '2-daily-reminders.json', '3-return.json'];
const TODAY = '2026-10-02';
const SETTINGS = { sheetUrl: 'x', itEmail: 'it@example.com', teamName: 'IT', pickupLocation: 'desk', requestFormUrl: 'r', returnFormUrl: 'u' };

// Run one Code node. `nodes` maps node name -> array of json items it "produced" earlier in the run.
function runCode(wf, nodeName, input, nodes) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `node ${nodeName} exists`);
  const wrap = (arr) => ({ all: () => arr.map((json) => ({ json })), first: () => ({ json: arr[0] }), item: { json: arr[0] } });
  const $ = (name) => { assert.ok(nodes[name], `referenced node ${name} has run`); return wrap(nodes[name]); };
  const $input = wrap(input);
  const $now = { toFormat: () => TODAY };
  const fn = new Function('$', '$input', '$now', node.parameters.jsCode);
  return fn($, $input, $now).map((i) => i.json);
}

test('every workflow is well-formed: unique names, all connections point at real nodes', () => {
  for (const f of files) {
    const wf = load(f);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.equal(names.size, wf.nodes.length, `${f}: duplicate node names`);
    for (const [from, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${f}: connection from missing node ${from}`);
      for (const out of main) for (const c of out) assert.ok(names.has(c.node), `${f}: ${from} -> missing ${c.node}`);
    }
    // every non-trigger node is reachable from something
    const targets = new Set(Object.values(wf.connections).flatMap((c) => c.main.flat().map((x) => x.node)));
    for (const n of wf.nodes) if (!/Trigger$/i.test(n.type)) assert.ok(targets.has(n.name), `${f}: ${n.name} is orphaned`);
  }
});

test('every Code node compiles', () => {
  for (const f of files) for (const n of load(f).nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$', '$input', '$now', n.parameters.jsCode), `${f}: ${n.name}`);
  }
});

test('every node expression references a node that exists', () => {
  for (const f of files) {
    const wf = load(f);
    const names = new Set(wf.nodes.map((n) => n.name));
    const text = JSON.stringify(wf.nodes.map((n) => n.parameters));
    for (const [, ref] of text.matchAll(/\$\('([^']+)'\)/g)) assert.ok(names.has(ref), `${f}: unknown node '${ref}'`);
  }
});

test('no real credentials or personal data are embedded', () => {
  for (const f of files) {
    const raw = readFileSync(new URL(`../workflows/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, /"credentials"\s*:/, f);
    assert.doesNotMatch(raw, /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/, f);
  }
});

// ---- request flow ---------------------------------------------------------------------------

const form = { 'Full name': 'Jordan Lee', 'Work email': 'jordan@example.com', 'Device type': 'Mac', 'Start date': TODAY, 'Number of days': 3, Reason: 'repair', settings: SETTINGS };
const inventory = [
  { 'Asset Tag': 'LN-MAC-01', Type: 'Mac', Model: 'MacBook Air', Status: 'Available', 'Last Returned': '' },
  { 'Asset Tag': 'LN-WIN-01', Type: 'Windows', Status: 'Checked Out' },
];

test('request: happy path picks a device and confirms the claim', () => {
  const wf = load('1-request.json');
  const nodes = { Settings: [form] };
  nodes['Validate request'] = runCode(wf, 'Validate request', [form], nodes);
  assert.equal(nodes['Validate request'][0].ok, true);
  nodes['Pick device'] = runCode(wf, 'Pick device', inventory, nodes);
  const p = nodes['Pick device'][0];
  assert.equal(p.found, true);
  assert.equal(p.assetTag, 'LN-MAC-01');
  const v = runCode(wf, 'Verify claim', [{ ...inventory[0], Status: 'Checked Out', 'Loan ID': p.loanId }], nodes)[0];
  assert.equal(v.claimed, true);
  assert.match(v.mail.subject, /Loaner confirmed: LN-MAC-01/);
  assert.equal(v.mail.to, 'jordan@example.com');
});

test('request: losing a simultaneous claim tells the user and alerts IT', () => {
  const wf = load('1-request.json');
  const nodes = { Settings: [form] };
  nodes['Validate request'] = runCode(wf, 'Validate request', [form], nodes);
  nodes['Pick device'] = runCode(wf, 'Pick device', inventory, nodes);
  const v = runCode(wf, 'Verify claim', [{ ...inventory[0], Status: 'Checked Out', 'Loan ID': 'LN-SOMEONE-ELSE' }], nodes)[0];
  assert.equal(v.claimed, false);
  assert.match(v.itAlert.body, /Assign by hand/);
});

test('request: no device of that type -> waitlist + IT alert (also with an empty sheet)', () => {
  const wf = load('1-request.json');
  for (const inv of [inventory.filter((d) => d.Type !== 'Mac'), [{}]]) {
    const nodes = { Settings: [form] };
    nodes['Validate request'] = runCode(wf, 'Validate request', [form], nodes);
    const p = runCode(wf, 'Pick device', inv, nodes)[0];
    assert.equal(p.found, false);
    assert.match(p.mail.subject, /no Mac available/);
    assert.match(p.itAlert.subject, /1 item/);
  }
});

test('request: invalid form goes back to the requester, or to IT if the email is unusable', () => {
  const wf = load('1-request.json');
  const bad = { ...form, 'Number of days': 30 };
  let v = runCode(wf, 'Validate request', [bad], { Settings: [bad] })[0];
  assert.equal(v.ok, false);
  assert.equal(v.mail.to, 'jordan@example.com');
  const worse = { ...bad, 'Work email': 'not-an-email' };
  v = runCode(wf, 'Validate request', [worse], { Settings: [worse] })[0];
  assert.equal(v.mail.to, 'it@example.com');
});

// ---- reminders flow -------------------------------------------------------------------------

test('reminders: one email per due-soon/overdue loan, IT digest only for overdue', () => {
  const wf = load('2-daily-reminders.json');
  const loans = [
    { 'Loan ID': 'A', Status: 'Active', 'Due Date': '2026-10-03', Name: 'A', Email: 'a@example.com', 'Asset Tag': 'T1' },
    { 'Loan ID': 'B', Status: 'Active', 'Due Date': '2026-09-30', Name: 'B', Email: 'b@example.com', 'Asset Tag': 'T2' },
    { 'Loan ID': 'C', Status: 'Returned', 'Due Date': '2026-09-01' },
  ];
  const nodes = { Settings: [{ settings: SETTINGS }] };
  nodes['Plan reminders'] = runCode(wf, 'Plan reminders', loans, nodes);
  assert.deepEqual(nodes['Plan reminders'].map((a) => a.kind), ['due-soon', 'overdue']);
  const d = runCode(wf, 'Build IT digest', [], nodes);
  assert.equal(d.length, 1);
  assert.match(d[0].itAlert.body, /T2 overdue 2d/);
});

test('reminders: nothing due -> no emails and no digest', () => {
  const wf = load('2-daily-reminders.json');
  const nodes = { Settings: [{ settings: SETTINGS }] };
  nodes['Plan reminders'] = runCode(wf, 'Plan reminders', [{}], nodes);
  assert.equal(nodes['Plan reminders'].length, 0);
  assert.equal(runCode(wf, 'Build IT digest', [], nodes).length, 0);
});

// ---- return flow ----------------------------------------------------------------------------

test('return: damaged device is matched, sent to repair, IT alerted', () => {
  const wf = load('3-return.json');
  const f = { 'Your work email': 'desk@example.com', 'Loan ID or asset tag': 'ln-mac-01', Condition: 'Damaged', Notes: 'cracked screen', settings: SETTINGS };
  const loans = [{ 'Loan ID': 'LN-1', 'Asset Tag': 'LN-MAC-01', Status: 'Active', 'Due Date': '2026-10-05', Email: 'j@example.com', Name: 'J' }];
  const r = runCode(wf, 'Match return', loans, { Settings: [f] })[0];
  assert.equal(r.ok, true);
  assert.equal(r.newDeviceStatus, 'Needs Repair');
  assert.equal(r.mail.to, 'j@example.com');
  assert.match(r.itAlert.body, /cracked screen/);
});

test('return: unknown device emails the person who submitted the form', () => {
  const wf = load('3-return.json');
  const f = { 'Your work email': 'desk@example.com', 'Loan ID or asset tag': 'NOPE', Condition: 'Good', settings: SETTINGS };
  const r = runCode(wf, 'Match return', [{}], { Settings: [f] })[0];
  assert.equal(r.ok, false);
  assert.equal(r.mail.to, 'desk@example.com');
});
