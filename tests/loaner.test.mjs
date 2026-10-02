import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const L = createRequire(import.meta.url)('../logic/loaner.js');
const TODAY = '2026-10-02';

const goodRequest = (over = {}) => ({
  name: 'Jordan Lee', email: 'Jordan.Lee@Example.com', deviceType: 'Mac',
  startDate: TODAY, days: '5', reason: 'Laptop in for repair', ...over,
});

// ---- dates -------------------------------------------------------------------------------

test('addDays crosses month and year boundaries', () => {
  assert.equal(L.addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(L.addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29'); // leap year
});

test('daysBetween is exact across DST changes', () => {
  assert.equal(L.daysBetween('2026-11-01', '2026-11-02'), 1); // US DST ends Nov 1 2026
  assert.equal(L.daysBetween('2026-03-07', '2026-03-09'), 2); // US DST starts Mar 8 2026
  assert.equal(L.daysBetween('2026-10-05', '2026-10-02'), -3);
});

test('isYmd rejects impossible dates', () => {
  assert.equal(L.isYmd('2026-02-30'), false);
  assert.equal(L.isYmd('10/02/2026'), false);
  assert.equal(L.isYmd('2026-10-02'), true);
});

// ---- validateRequest ---------------------------------------------------------------------

test('a valid request is normalized and gets a due date', () => {
  const r = L.validateRequest(goodRequest(), TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.request.email, 'jordan.lee@example.com');
  assert.equal(r.request.days, 5);
  assert.equal(r.request.dueDate, '2026-10-07');
});

test('invalid requests list every problem at once', () => {
  const r = L.validateRequest({ name: '', email: 'nope', deviceType: 'Toaster', startDate: '2026-10-01', days: '0' }, TODAY);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5);
});

test('loan length is capped and must be a whole number', () => {
  assert.equal(L.validateRequest(goodRequest({ days: '15' }), TODAY).ok, false);
  assert.equal(L.validateRequest(goodRequest({ days: '2.5' }), TODAY).ok, false);
  assert.equal(L.validateRequest(goodRequest({ days: '14' }), TODAY).ok, true);
});

test('start date cannot be in the past or more than 30 days out', () => {
  assert.equal(L.validateRequest(goodRequest({ startDate: '2026-10-01' }), TODAY).ok, false);
  assert.equal(L.validateRequest(goodRequest({ startDate: '2026-11-02' }), TODAY).ok, false);
  assert.equal(L.validateRequest(goodRequest({ startDate: '2026-11-01' }), TODAY).ok, true);
});

test('long reasons are truncated, not rejected', () => {
  const r = L.validateRequest(goodRequest({ reason: 'x'.repeat(2000) }), TODAY);
  assert.equal(r.request.reason.length, 500);
});

// ---- pickDevice --------------------------------------------------------------------------

const inventory = [
  { 'Asset Tag': 'LN-MAC-03', Type: 'Mac', Status: 'Available', 'Last Returned': '2026-09-20' },
  { 'Asset Tag': 'LN-MAC-01', Type: 'Mac', Status: 'Checked Out', 'Last Returned': '2026-08-01' },
  { 'Asset Tag': 'LN-MAC-02', Type: 'Mac', Status: 'Available', 'Last Returned': '2026-09-01' },
  { 'Asset Tag': 'LN-WIN-01', Type: 'Windows', Status: 'Needs Repair', 'Last Returned': '' },
  { 'Asset Tag': 'LN-WIN-02', Type: 'Windows', Status: 'Available', 'Last Returned': '' },
];

test('picks the available device of the right type that has been idle longest', () => {
  assert.equal(L.pickDevice(inventory, 'Mac')['Asset Tag'], 'LN-MAC-02');
});

test('never picks a device that is checked out or in repair', () => {
  assert.equal(L.pickDevice(inventory, 'Windows')['Asset Tag'], 'LN-WIN-02');
  const none = inventory.map((d) => ({ ...d, Status: d.Type === 'Mac' ? 'Checked Out' : d.Status }));
  assert.equal(L.pickDevice(none, 'Mac'), null);
});

test('returns null when no device of that type exists', () => {
  assert.equal(L.pickDevice(inventory, 'iPad'), null);
});

test('never-loaned devices go out before recently returned ones', () => {
  const inv = [
    { 'Asset Tag': 'B', Type: 'Mac', Status: 'Available', 'Last Returned': '2026-01-01' },
    { 'Asset Tag': 'A', Type: 'Mac', Status: 'Available', 'Last Returned': '' },
  ];
  assert.equal(L.pickDevice(inv, 'Mac')['Asset Tag'], 'A');
});

// ---- loan IDs and claim verification ----------------------------------------------------

test('loan IDs are date-prefixed and avoid look-alike characters', () => {
  const id = L.makeLoanId(TODAY);
  assert.match(id, /^LN-20261002-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(L.makeLoanId(TODAY, () => 0), 'LN-20261002-AAAA');
});

test('verifyClaim detects when another request grabbed the device first', () => {
  assert.equal(L.verifyClaim({ 'Loan ID': 'LN-1', Status: 'Checked Out' }, 'LN-1'), true);
  assert.equal(L.verifyClaim({ 'Loan ID': 'LN-2', Status: 'Checked Out' }, 'LN-1'), false);
  assert.equal(L.verifyClaim({ 'Loan ID': 'LN-1', Status: 'Available' }, 'LN-1'), false);
});

// ---- planReminders -----------------------------------------------------------------------

const loan = (over) => ({ 'Loan ID': 'LN-X', Status: 'Active', 'Due Date': '2026-10-03', 'Due Soon Sent': '', 'Last Overdue Notice': '', ...over });

test('sends a due-soon reminder the day before the due date', () => {
  const a = L.planReminders([loan()], TODAY);
  assert.deepEqual(a.map((x) => x.kind), ['due-soon']);
});

test('never sends the due-soon reminder twice', () => {
  assert.equal(L.planReminders([loan({ 'Due Soon Sent': '2026-10-02' })], TODAY).length, 0);
});

test('overdue loans get one notice per day, with days overdue', () => {
  const a = L.planReminders([loan({ 'Due Date': '2026-09-29' })], TODAY);
  assert.equal(a[0].kind, 'overdue');
  assert.equal(a[0].daysOverdue, 3);
  assert.equal(L.planReminders([loan({ 'Due Date': '2026-09-29', 'Last Overdue Notice': TODAY })], TODAY).length, 0);
  assert.equal(L.planReminders([loan({ 'Due Date': '2026-09-29', 'Last Overdue Notice': '2026-10-01' })], TODAY).length, 1);
});

test('closed, waitlisted and not-yet-due loans are ignored', () => {
  const loans = [
    loan({ Status: 'Returned', 'Due Date': '2026-09-01' }),
    loan({ Status: 'Waitlisted', 'Due Date': '2026-09-01' }),
    loan({ 'Due Date': '2026-10-02' }), // due today: no reminder, not overdue yet
    loan({ 'Due Date': '2026-10-10' }),
    loan({ 'Due Date': 'garbage' }),
  ];
  assert.equal(L.planReminders(loans, TODAY).length, 0);
});

// ---- processReturn -----------------------------------------------------------------------

const loans = [
  { 'Loan ID': 'LN-20260925-AB12', 'Asset Tag': 'LN-MAC-01', Status: 'Active', 'Due Date': '2026-09-30', Email: 'a@example.com', Name: 'A' },
  { 'Loan ID': 'LN-20260901-ZZZZ', 'Asset Tag': 'LN-MAC-02', Status: 'Returned', 'Due Date': '2026-09-05', Email: 'b@example.com', Name: 'B' },
];

test('a good-condition return by Loan ID frees the device and computes lateness', () => {
  const r = L.processReturn({ loanIdOrAssetTag: 'ln-20260925-ab12', condition: 'Good' }, loans, TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.newDeviceStatus, 'Available');
  assert.equal(r.alertIT, false);
  assert.equal(r.daysLate, 2);
});

test('a return can be matched by asset tag', () => {
  const r = L.processReturn({ loanIdOrAssetTag: 'LN-MAC-01', condition: 'Good' }, loans, TODAY);
  assert.equal(r.loanId, 'LN-20260925-AB12');
});

test('damaged or incomplete returns go to repair and alert IT', () => {
  for (const condition of ['Damaged', 'Missing accessories']) {
    const r = L.processReturn({ loanIdOrAssetTag: 'LN-MAC-01', condition }, loans, TODAY);
    assert.equal(r.newDeviceStatus, 'Needs Repair');
    assert.equal(r.alertIT, true);
  }
});

test('cannot return a loan that is already closed or does not exist', () => {
  assert.equal(L.processReturn({ loanIdOrAssetTag: 'LN-MAC-02', condition: 'Good' }, loans, TODAY).ok, false);
  assert.equal(L.processReturn({ loanIdOrAssetTag: 'NOPE', condition: 'Good' }, loans, TODAY).ok, false);
  assert.equal(L.processReturn({ loanIdOrAssetTag: '', condition: 'Good' }, loans, TODAY).ok, false);
  assert.equal(L.processReturn({ loanIdOrAssetTag: 'LN-MAC-01', condition: 'Meh' }, loans, TODAY).ok, false);
});

// ---- emails ------------------------------------------------------------------------------

const settings = { teamName: 'IT Service Desk', pickupLocation: 'IT desk, 3rd floor', requestFormUrl: 'https://n8n.example.com/form/loaner-request', returnFormUrl: 'https://n8n.example.com/form/loaner-return' };

test('every email kind renders without undefined/null placeholders', () => {
  const loanRow = { 'Loan ID': 'LN-1', 'Asset Tag': 'LN-MAC-01', Name: 'A', Email: 'a@example.com', 'Due Date': '2026-10-03' };
  const cases = {
    confirmed: { email: 'a@example.com', name: 'A', deviceType: 'Mac', assetTag: 'LN-MAC-01', model: 'MacBook Air', startDate: TODAY, dueDate: '2026-10-07', loanId: 'LN-1' },
    waitlisted: { email: 'a@example.com', name: 'A', deviceType: 'Mac', loanId: 'LN-1' },
    invalid: { notifyTo: 'a@example.com', errors: ['Name is required.'] },
    conflict: { email: 'a@example.com', name: 'A', loanId: 'LN-1' },
    'due-soon': { loan: loanRow, loanId: 'LN-1' },
    overdue: { loan: loanRow, loanId: 'LN-1', daysOverdue: 1 },
    returned: { email: 'a@example.com', name: 'A', assetTag: 'LN-MAC-01', loanId: 'LN-1', returnedOn: TODAY, alertIT: true, condition: 'Damaged' },
    'return-problem': { notifyTo: 'a@example.com', error: 'No active loan found.' },
  };
  for (const [kind, d] of Object.entries(cases)) {
    const e = L.buildEmail(kind, d, settings);
    assert.ok(e.to && e.subject && e.body, kind);
    assert.doesNotMatch(e.subject + e.body, /undefined|null|\[object/, kind);
  }
  assert.match(L.buildEmail('overdue', cases.overdue, settings).body, /1 day overdue/);
  assert.throws(() => L.buildEmail('nope', {}, settings));
});

test('IT digest is skipped when there is nothing to report', () => {
  assert.equal(L.buildItDigest([], TODAY), null);
  assert.match(L.buildItDigest([{ title: 'a' }, { title: 'b', detail: 'x' }], TODAY).subject, /2 items/);
});
