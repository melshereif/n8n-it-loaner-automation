// Core decision logic for the loaner-device workflows.
//
// Every function here is pure (no I/O, no n8n globals) so it can be unit-tested with node:test.
// scripts/build.mjs copies these functions verbatim into the n8n Code nodes, so the tested code
// and the code that runs in n8n are the same code.
//
// Dates are handled as 'YYYY-MM-DD' strings in the workflow's timezone to avoid off-by-one bugs
// from mixing local time and UTC.

const MAX_LOAN_DAYS = 14;
const DEVICE_TYPES = ['Mac', 'Windows', 'Chromebook', 'iPad'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ymdToUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((ymdToUtc(toYmd) - ymdToUtc(fromYmd)) / 86400000);
}

function addDays(ymd, days) {
  return new Date(ymdToUtc(ymd) + days * 86400000).toISOString().slice(0, 10);
}

function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  return addDays(s, 0) === s; // rejects 2026-02-30 etc.
}

// Validate and normalize a loaner request coming from the n8n Form Trigger.
// Returns { ok: true, request } or { ok: false, errors: [...] }.
function validateRequest(raw, todayYmd) {
  const errors = [];
  const name = String(raw.name || '').trim();
  const email = String(raw.email || '').trim().toLowerCase();
  const deviceType = String(raw.deviceType || '').trim();
  const startDate = String(raw.startDate || '').trim();
  const days = Number(raw.days);
  const reason = String(raw.reason || '').trim().slice(0, 500);

  if (!name) errors.push('Name is required.');
  if (!EMAIL_RE.test(email)) errors.push('A valid email is required.');
  if (!DEVICE_TYPES.includes(deviceType)) errors.push(`Device type must be one of: ${DEVICE_TYPES.join(', ')}.`);
  if (!isYmd(startDate)) errors.push('Start date must be a valid date.');
  else if (startDate < todayYmd) errors.push('Start date cannot be in the past.');
  else if (daysBetween(todayYmd, startDate) > 30) errors.push('Requests can be made up to 30 days ahead.');
  if (!Number.isInteger(days) || days < 1 || days > MAX_LOAN_DAYS) errors.push(`Loan length must be 1-${MAX_LOAN_DAYS} days.`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    request: { name, email, deviceType, startDate, days, dueDate: addDays(startDate, days), reason },
  };
}

// Pick an available device of the requested type.
// Fair rotation: the device that has been sitting idle longest goes out first, which spreads wear
// across the fleet. Devices with no Last Returned date count as idle the longest.
function pickDevice(inventory, deviceType) {
  const candidates = inventory.filter(
    (d) => String(d['Status']).trim() === 'Available' && String(d['Type']).trim() === deviceType,
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ra = String(a['Last Returned'] || ''), rb = String(b['Last Returned'] || '');
    if (ra !== rb) return ra < rb ? -1 : 1;
    return String(a['Asset Tag']).localeCompare(String(b['Asset Tag']));
  });
  return candidates[0];
}

// Loan IDs look like LN-20261002-7F3K. Date prefix keeps them sortable; random suffix avoids
// collisions when two requests arrive in the same second.
function makeLoanId(todayYmd, rand = Math.random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(rand() * alphabet.length)];
  return `LN-${todayYmd.replace(/-/g, '')}-${suffix}`;
}

// After writing "Checked Out" to the inventory row, the workflow re-reads that row.
// If another request claimed the same device in between, the Loan ID won't match ours.
function verifyClaim(rowAfterWrite, loanId) {
  return String(rowAfterWrite['Loan ID'] || '').trim() === loanId
    && String(rowAfterWrite['Status'] || '').trim() === 'Checked Out';
}

// Decide which reminder emails to send today.
// Each loan gets at most ONE "due soon" reminder and at most ONE overdue notice per day, recorded
// in the Loans sheet ('Due Soon Sent', 'Last Overdue Notice') so re-running the workflow the same
// day sends nothing twice.
function planReminders(loans, todayYmd) {
  const actions = [];
  for (const loan of loans) {
    if (String(loan['Status']).trim() !== 'Active') continue;
    const due = String(loan['Due Date'] || '').trim();
    if (!isYmd(due)) continue;
    const daysLeft = daysBetween(todayYmd, due);

    if (daysLeft === 1 && !String(loan['Due Soon Sent'] || '').trim()) {
      actions.push({ kind: 'due-soon', loanId: loan['Loan ID'], loan, daysLeft });
    } else if (daysLeft < 0 && String(loan['Last Overdue Notice'] || '').trim() !== todayYmd) {
      actions.push({ kind: 'overdue', loanId: loan['Loan ID'], loan, daysOverdue: -daysLeft });
    }
  }
  return actions;
}

// Process a return submitted on the return form.
// Matches on Loan ID or Asset Tag (people remember one or the other), only against Active loans.
function processReturn(raw, loans, todayYmd) {
  const key = String(raw.loanIdOrAssetTag || '').trim().toUpperCase();
  const condition = String(raw.condition || '').trim();
  if (!key) return { ok: false, error: 'Enter the Loan ID or the asset tag on the device.' };
  if (!['Good', 'Damaged', 'Missing accessories'].includes(condition))
    return { ok: false, error: 'Choose the device condition.' };

  const loan = loans.find(
    (l) => String(l['Status']).trim() === 'Active'
      && (String(l['Loan ID']).toUpperCase() === key || String(l['Asset Tag']).toUpperCase() === key),
  );
  if (!loan) return { ok: false, error: `No active loan found for "${key}".` };

  const needsRepair = condition !== 'Good';
  const due = String(loan['Due Date'] || '');
  return {
    ok: true,
    loanId: loan['Loan ID'],
    assetTag: loan['Asset Tag'],
    email: loan['Email'],
    name: loan['Name'],
    returnedOn: todayYmd,
    daysLate: isYmd(due) ? Math.max(0, daysBetween(due, todayYmd)) : 0,
    newDeviceStatus: needsRepair ? 'Needs Repair' : 'Available',
    alertIT: needsRepair,
    condition,
    notes: String(raw.notes || '').trim().slice(0, 500),
  };
}

// Plain-text emails. Kept here (not typed into n8n nodes) so wording is reviewed and tested in one place.
// Returns { to, subject, body }.
function buildEmail(kind, d, settings) {
  const sign = `\n\n${settings.teamName}`;
  switch (kind) {
    case 'confirmed':
      return {
        to: d.email,
        subject: `Loaner confirmed: ${d.assetTag} (${d.loanId})`,
        body: `Hi ${d.name},\n\nYour ${d.deviceType} loaner is reserved.\n\n`
          + `Device: ${d.assetTag}${d.model ? ` (${d.model})` : ''}\nPick up: ${d.startDate} at ${settings.pickupLocation}\n`
          + `Return by: ${d.dueDate}\nLoan ID: ${d.loanId}\n\n`
          + `Keep this Loan ID. You'll need it (or the asset tag on the device) to return it: ${settings.returnFormUrl}${sign}`,
      };
    case 'waitlisted':
      return {
        to: d.email,
        subject: `Loaner request received: no ${d.deviceType} available yet (${d.loanId})`,
        body: `Hi ${d.name},\n\nAll ${d.deviceType} loaners are out right now. You're on the waitlist and IT has been notified.\n`
          + `We'll email you as soon as one is available.\n\nRequest ID: ${d.loanId}${sign}`,
      };
    case 'invalid':
      return {
        to: d.notifyTo,
        subject: 'Loaner request: a few details need fixing',
        body: `Hi,\n\nWe couldn't process your loaner request:\n\n- ${d.errors.join('\n- ')}\n\n`
          + `Please submit the form again: ${settings.requestFormUrl}${sign}`,
      };
    case 'conflict':
      return {
        to: d.email,
        subject: `Loaner request received (${d.loanId})`,
        body: `Hi ${d.name},\n\nWe got your request. Another request claimed the same device at the same moment, `
          + `so IT will assign yours by hand and email you shortly.\n\nRequest ID: ${d.loanId}${sign}`,
      };
    case 'due-soon':
      return {
        to: d.loan['Email'],
        subject: `Reminder: loaner ${d.loan['Asset Tag']} is due tomorrow`,
        body: `Hi ${d.loan['Name']},\n\nFriendly reminder: loaner ${d.loan['Asset Tag']} is due back tomorrow (${d.loan['Due Date']}).\n`
          + `Return it to ${settings.pickupLocation} and log the return here: ${settings.returnFormUrl}\n\nLoan ID: ${d.loanId}${sign}`,
      };
    case 'overdue':
      return {
        to: d.loan['Email'],
        subject: `Overdue: loaner ${d.loan['Asset Tag']} was due ${d.loan['Due Date']}`,
        body: `Hi ${d.loan['Name']},\n\nLoaner ${d.loan['Asset Tag']} is ${d.daysOverdue} day${d.daysOverdue === 1 ? '' : 's'} overdue `
          + `(due ${d.loan['Due Date']}). Please return it to ${settings.pickupLocation} as soon as possible, `
          + `or reply to this email if you need more time.\n\nLoan ID: ${d.loanId}${sign}`,
      };
    case 'returned':
      return {
        to: d.email,
        subject: `Loaner returned: ${d.assetTag} (${d.loanId})`,
        body: `Hi ${d.name},\n\nThanks, we've logged the return of ${d.assetTag} on ${d.returnedOn}. Your loan is closed.`
          + (d.alertIT ? `\n\nYou reported: ${d.condition}. IT will take a look.` : '') + sign,
      };
    case 'return-problem':
      return {
        to: d.notifyTo,
        subject: 'Loaner return: we could not match your device',
        body: `Hi,\n\n${d.error}\n\nPlease check the Loan ID in your confirmation email (or the asset tag sticker) and submit `
          + `the return form again: ${settings.returnFormUrl}${sign}`,
      };
    default:
      throw new Error(`Unknown email kind: ${kind}`);
  }
}

// One summary email to IT instead of one email per problem.
function buildItDigest(items, todayYmd) {
  if (!items.length) return null;
  const lines = items.map((i) => `- ${i.title}${i.detail ? `: ${i.detail}` : ''}`);
  return { subject: `[Loaners] ${items.length} item${items.length === 1 ? '' : 's'} need attention (${todayYmd})`, body: lines.join('\n') };
}

module.exports = {
  MAX_LOAN_DAYS, DEVICE_TYPES,
  addDays, daysBetween, isYmd, validateRequest, pickDevice, makeLoanId, verifyClaim, planReminders, processReturn,
  buildEmail, buildItDigest,
};
