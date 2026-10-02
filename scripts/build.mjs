// Generates the three importable n8n workflows in workflows/ from logic/loaner.js.
//
//   node scripts/build.mjs
//
// The tested logic is embedded verbatim in each Code node, so what the tests cover is exactly what
// runs inside n8n. Never hand-edit workflows/*.json; change the logic or this script and rebuild.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url);
const LOGIC = readFileSync(new URL('logic/loaner.js', root), 'utf8').replace(/\nmodule\.exports = \{[\s\S]*?\};\s*$/, '\n');

// Stable IDs so rebuilding produces a clean diff.
const uuid = (seed) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const SETTINGS_CODE = `// ===== EDIT THESE FOR YOUR TEAM =====
const SETTINGS = {
  sheetUrl: 'PASTE_YOUR_GOOGLE_SHEET_URL_HERE',
  itEmail: 'it-team@example.com',          // gets waitlist, conflict, overdue and repair alerts
  teamName: 'IT Service Desk',             // email signature
  pickupLocation: 'the IT desk',
  requestFormUrl: 'https://YOUR-N8N-HOST/form/loaner-request',
  returnFormUrl: 'https://YOUR-N8N-HOST/form/loaner-return',
};
// =====================================
return $input.all().map((item) => ({ json: { ...item.json, settings: SETTINGS } }));`;

function workflow(name, build) {
  const nodes = [];
  const connections = {};
  let col = 0;
  const add = (nodeName, type, typeVersion, parameters, { row = 0, extra = {} } = {}) => {
    nodes.push({
      id: uuid(`${name}/${nodeName}`), name: nodeName, type, typeVersion,
      position: [col++ * 240, row * 200], parameters, ...extra,
    });
    return nodeName;
  };
  const link = (from, to, output = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  };
  const chain = (...names) => names.slice(1).forEach((n, i) => link(names[i], n));
  build({ add, link, chain });
  return {
    name, nodes, connections, pinData: {}, active: false,
    settings: { executionOrder: 'v1', timezone: 'America/New_York', saveManualExecutions: true },
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

// ---- node helpers -------------------------------------------------------------------------

const code = (js) => ['n8n-nodes-base.code', 2, { jsCode: js }];
const settingsNode = () => code(SETTINGS_CODE);
const doc = { __rl: true, mode: 'url', value: "={{ $('Settings').first().json.settings.sheetUrl }}" };
const sheet = (s) => ({ __rl: true, mode: 'name', value: s });

const readSheet = (sheetName, filter) => ['n8n-nodes-base.googleSheets', 4.5, {
  operation: 'read', documentId: doc, sheetName: sheet(sheetName),
  ...(filter ? { filtersUI: { values: [filter] } } : {}),
  options: {},
}];

const schemaOf = (cols) => cols.map((c) => ({
  id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true,
}));

const writeSheet = (operation, sheetName, values, matchOn) => ['n8n-nodes-base.googleSheets', 4.5, {
  operation, documentId: doc, sheetName: sheet(sheetName),
  columns: {
    mappingMode: 'defineBelow', value: values,
    matchingColumns: matchOn ? [matchOn] : [],
    schema: schemaOf(Object.keys(values)),
  },
  options: { cellFormat: 'RAW' }, // keep dates as plain YYYY-MM-DD text
}];

const gmail = (to, subject, message) => ['n8n-nodes-base.gmail', 2.1, {
  resource: 'message', operation: 'send', sendTo: to, subject, emailType: 'text', message,
  options: { appendAttribution: false },
}];
const mailFrom = (node, field = 'mail') => gmail(
  `={{ $('${node}').first().json.${field}.to }}`,
  `={{ $('${node}').first().json.${field}.subject }}`,
  `={{ $('${node}').first().json.${field}.body }}`,
);
const itMailFrom = (node) => gmail(
  "={{ $('Settings').first().json.settings.itEmail }}",
  `={{ $('${node}').first().json.itAlert.subject }}`,
  `={{ $('${node}').first().json.itAlert.body }}`,
);

const ifTrue = (expr) => ['n8n-nodes-base.if', 2.2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uuid(expr), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
}];

const formTrigger = (path, title, description, fields, submitted) => ['n8n-nodes-base.formTrigger', 2.2, {
  formTitle: title, formDescription: description,
  formFields: { values: fields },
  responseMode: 'onReceived',
  options: { path, respondWithOptions: { values: { formSubmittedText: submitted } }, appendAttribution: false },
}];

const put = (add, name, [type, ver, params], opts = {}) => add(name, type, ver, params, opts);

// ---- 1. Request ---------------------------------------------------------------------------

const loanRow = (src, status, assetTag) => ({
  'Loan ID': `={{ $('${src}').first().json.loanId }}`,
  'Created': `={{ $('${src}').first().json.today }}`,
  'Name': `={{ $('${src}').first().json.name }}`,
  'Email': `={{ $('${src}').first().json.email }}`,
  'Device Type': `={{ $('${src}').first().json.deviceType }}`,
  'Asset Tag': assetTag,
  'Start Date': `={{ $('${src}').first().json.startDate }}`,
  'Due Date': `={{ $('${src}').first().json.dueDate }}`,
  'Reason': `={{ $('${src}').first().json.reason }}`,
  'Status': status,
});

const request = workflow('IT Loaner - 1. Request', ({ add, link, chain }) => {
  const trigger = put(add, 'Loaner request form', formTrigger('loaner-request', 'Request a loaner device',
    'Need a temporary laptop or tablet? Fill this in and you will get an email confirmation.',
    [
      { fieldLabel: 'Full name', requiredField: true },
      { fieldLabel: 'Work email', fieldType: 'email', requiredField: true },
      { fieldLabel: 'Device type', fieldType: 'dropdown', requiredField: true,
        fieldOptions: { values: ['Mac', 'Windows', 'Chromebook', 'iPad'].map((option) => ({ option })) } },
      { fieldLabel: 'Start date', fieldType: 'date', requiredField: true },
      { fieldLabel: 'Number of days', fieldType: 'number', requiredField: true, placeholder: '1-14' },
      { fieldLabel: 'Reason', fieldType: 'textarea', placeholder: 'e.g. my laptop is in for repair' },
    ],
    'Thanks! Check your email in a minute for your loaner confirmation.'), { extra: { webhookId: uuid('form/loaner-request') } });

  const settings = put(add, 'Settings', settingsNode());
  const validate = put(add, 'Validate request', code(`${LOGIC}
const f = $('Settings').first().json;
const today = $now.toFormat('yyyy-MM-dd');
const v = validateRequest({
  name: f['Full name'], email: f['Work email'], deviceType: f['Device type'],
  startDate: f['Start date'], days: f['Number of days'], reason: f['Reason'],
}, today);
const loanId = makeLoanId(today);
const typed = String(f['Work email'] || '').trim().toLowerCase();
const notifyTo = EMAIL_RE.test(typed) ? typed : f.settings.itEmail;
const mail = v.ok ? null : buildEmail('invalid', { notifyTo, errors: v.errors }, f.settings);
return [{ json: { ok: v.ok, ...(v.request || {}), errors: v.errors || [], loanId, today, mail } }];`));
  const isValid = put(add, 'Valid?', ifTrue("={{ $json.ok }}"));
  const mailInvalid = put(add, 'Email: fix your request', mailFrom('Validate request'), { row: 1 });

  const readInv = put(add, 'Read inventory', readSheet('Inventory'), { extra: { alwaysOutputData: true } });
  const pick = put(add, 'Pick device', code(`${LOGIC}
const v = $('Validate request').first().json;
const settings = $('Settings').first().json.settings;
const device = pickDevice($input.all().map((i) => i.json), v.deviceType);
if (!device) {
  return [{ json: { ...v, found: false,
    mail: buildEmail('waitlisted', v, settings),
    itAlert: buildItDigest([{ title: \`Waitlisted: \${v.name} needs a \${v.deviceType}\`, detail: \`from \${v.startDate} for \${v.days} days (\${v.loanId})\` }], v.today) } }];
}
return [{ json: { ...v, found: true, assetTag: String(device['Asset Tag']), model: String(device['Model'] || '') } }];`));
  const found = put(add, 'Device available?', ifTrue("={{ $json.found }}"));

  const claim = put(add, 'Claim device', writeSheet('update', 'Inventory', {
    'Asset Tag': "={{ $('Pick device').first().json.assetTag }}",
    'Status': 'Checked Out',
    'Loan ID': "={{ $('Pick device').first().json.loanId }}",
    'Assigned To': "={{ $('Pick device').first().json.email }}",
    'Due Date': "={{ $('Pick device').first().json.dueDate }}",
  }, 'Asset Tag'));
  const reread = put(add, 'Re-read device', readSheet('Inventory', { lookupColumn: 'Asset Tag', lookupValue: "={{ $('Pick device').first().json.assetTag }}" }),
    { extra: { alwaysOutputData: true } });
  const verify = put(add, 'Verify claim', code(`${LOGIC}
const p = $('Pick device').first().json;
const settings = $('Settings').first().json.settings;
const claimed = verifyClaim($input.first().json, p.loanId);
return [{ json: { ...p, claimed,
  mail: buildEmail(claimed ? 'confirmed' : 'conflict', p, settings),
  itAlert: claimed ? null : buildItDigest([{ title: \`Assign by hand: \${p.name} (\${p.loanId})\`, detail: \`\${p.assetTag} was claimed by another request at the same moment\` }], p.today) } }];`));
  const claimedIf = put(add, 'Claim confirmed?', ifTrue("={{ $json.claimed }}"));

  const logActive = put(add, 'Log loan (Active)', writeSheet('append', 'Loans', loanRow('Verify claim', 'Active', "={{ $('Verify claim').first().json.assetTag }}")));
  const mailConfirm = put(add, 'Email: confirmed', mailFrom('Verify claim'));

  const logConflict = put(add, 'Log loan (Needs Assignment)', writeSheet('append', 'Loans', loanRow('Verify claim', 'Needs Assignment', '')), { row: 1 });
  const mailConflict = put(add, 'Email: we will follow up', mailFrom('Verify claim'), { row: 1 });
  const itConflict = put(add, 'Alert IT: conflict', itMailFrom('Verify claim'), { row: 1 });

  const logWait = put(add, 'Log loan (Waitlisted)', writeSheet('append', 'Loans', loanRow('Pick device', 'Waitlisted', '')), { row: 2 });
  const mailWait = put(add, 'Email: waitlisted', mailFrom('Pick device'), { row: 2 });
  const itWait = put(add, 'Alert IT: waitlist', itMailFrom('Pick device'), { row: 2 });

  chain(trigger, settings, validate, isValid);
  link(isValid, readInv, 0); link(isValid, mailInvalid, 1);
  chain(readInv, pick, found);
  link(found, claim, 0); link(found, logWait, 1);
  chain(claim, reread, verify, claimedIf);
  link(claimedIf, logActive, 0); link(claimedIf, logConflict, 1);
  chain(logActive, mailConfirm);
  chain(logConflict, mailConflict, itConflict);
  chain(logWait, mailWait, itWait);
});

// ---- 2. Daily reminders -------------------------------------------------------------------

const reminders = workflow('IT Loaner - 2. Daily Reminders', ({ add, chain }) => {
  const trigger = put(add, 'Every weekday 8am', ['n8n-nodes-base.scheduleTrigger', 1.2, {
    rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] },
  }]);
  const settings = put(add, 'Settings', settingsNode());
  const readLoans = put(add, 'Read loans', readSheet('Loans'), { extra: { alwaysOutputData: true } });
  const plan = put(add, 'Plan reminders', code(`${LOGIC}
const settings = $('Settings').first().json.settings;
const today = $now.toFormat('yyyy-MM-dd');
const actions = planReminders($input.all().map((i) => i.json), today);
// Returning no items stops the workflow here: nothing to send today.
return actions.map((a) => ({ json: { ...a, today, mail: buildEmail(a.kind, a, settings) } }));`));
  const send = put(add, 'Email: reminder', gmail('={{ $json.mail.to }}', '={{ $json.mail.subject }}', '={{ $json.mail.body }}'));
  // Mark AFTER sending: if Gmail fails, the reminder is retried on the next run instead of being lost.
  const mark = put(add, 'Mark reminder sent', writeSheet('update', 'Loans', {
    'Loan ID': "={{ $('Plan reminders').item.json.loanId }}",
    'Due Soon Sent': "={{ $('Plan reminders').item.json.kind === 'due-soon' ? $('Plan reminders').item.json.today : ($('Plan reminders').item.json.loan['Due Soon Sent'] || '') }}",
    'Last Overdue Notice': "={{ $('Plan reminders').item.json.kind === 'overdue' ? $('Plan reminders').item.json.today : ($('Plan reminders').item.json.loan['Last Overdue Notice'] || '') }}",
  }, 'Loan ID'));
  const digest = put(add, 'Build IT digest', code(`${LOGIC}
const today = $now.toFormat('yyyy-MM-dd');
const overdue = $('Plan reminders').all().map((i) => i.json).filter((a) => a.kind === 'overdue');
const d = buildItDigest(overdue.map((a) => ({
  title: \`\${a.loan['Asset Tag']} overdue \${a.daysOverdue}d\`,
  detail: \`\${a.loan['Name']} <\${a.loan['Email']}>, due \${a.loan['Due Date']} (\${a.loanId})\`,
})), today);
return d ? [{ json: { itAlert: d } }] : [];`));
  const itMail = put(add, 'Email IT: overdue digest', itMailFrom('Build IT digest'));
  chain(trigger, settings, readLoans, plan, send, mark, digest, itMail);
});

// ---- 3. Return ----------------------------------------------------------------------------

const ret = workflow('IT Loaner - 3. Return', ({ add, link, chain }) => {
  const trigger = put(add, 'Loaner return form', formTrigger('loaner-return', 'Return a loaner device',
    'Log a returned loaner. IT staff can fill this in at the desk when the device is handed back.',
    [
      { fieldLabel: 'Your work email', fieldType: 'email', requiredField: true },
      { fieldLabel: 'Loan ID or asset tag', requiredField: true, placeholder: 'LN-20261002-7F3K or LN-MAC-01' },
      { fieldLabel: 'Condition', fieldType: 'dropdown', requiredField: true,
        fieldOptions: { values: ['Good', 'Damaged', 'Missing accessories'].map((option) => ({ option })) } },
      { fieldLabel: 'Notes', fieldType: 'textarea' },
    ],
    'Thanks! The return has been logged and a confirmation email is on its way.'), { extra: { webhookId: uuid('form/loaner-return') } });
  const settings = put(add, 'Settings', settingsNode());
  const readLoans = put(add, 'Read loans', readSheet('Loans'), { extra: { alwaysOutputData: true } });
  const proc = put(add, 'Match return', code(`${LOGIC}
const f = $('Settings').first().json;
const today = $now.toFormat('yyyy-MM-dd');
const r = processReturn({ loanIdOrAssetTag: f['Loan ID or asset tag'], condition: f['Condition'], notes: f['Notes'] },
  $input.all().map((i) => i.json), today);
const typed = String(f['Your work email'] || '').trim().toLowerCase();
const notifyTo = EMAIL_RE.test(typed) ? typed : f.settings.itEmail;
if (!r.ok) return [{ json: { ok: false, mail: buildEmail('return-problem', { notifyTo, error: r.error }, f.settings) } }];
return [{ json: { ...r, mail: buildEmail('returned', r, f.settings),
  itAlert: r.alertIT ? buildItDigest([{ title: \`\${r.assetTag} returned: \${r.condition}\`, detail: \`\${r.name} <\${r.email}>, loan \${r.loanId}\${r.notes ? ' | notes: ' + r.notes : ''}\` }], today) : null } }];`));
  const okIf = put(add, 'Matched?', ifTrue("={{ $json.ok }}"));
  const mailProblem = put(add, 'Email: could not match', mailFrom('Match return'), { row: 1 });
  const freeDevice = put(add, 'Update device status', writeSheet('update', 'Inventory', {
    'Asset Tag': "={{ $('Match return').first().json.assetTag }}",
    'Status': "={{ $('Match return').first().json.newDeviceStatus }}",
    'Loan ID': '', 'Assigned To': '', 'Due Date': '',
    'Last Returned': "={{ $('Match return').first().json.returnedOn }}",
  }, 'Asset Tag'));
  const closeLoan = put(add, 'Close loan', writeSheet('update', 'Loans', {
    'Loan ID': "={{ $('Match return').first().json.loanId }}",
    'Status': 'Returned',
    'Returned On': "={{ $('Match return').first().json.returnedOn }}",
    'Condition': "={{ $('Match return').first().json.condition }}",
    'Days Late': "={{ $('Match return').first().json.daysLate }}",
    'Return Notes': "={{ $('Match return').first().json.notes }}",
  }, 'Loan ID'));
  const mailDone = put(add, 'Email: return confirmed', mailFrom('Match return'));
  const repairIf = put(add, 'Needs repair?', ifTrue("={{ $('Match return').first().json.alertIT }}"));
  const itRepair = put(add, 'Alert IT: repair', itMailFrom('Match return'));
  chain(trigger, settings, readLoans, proc, okIf);
  link(okIf, freeDevice, 0); link(okIf, mailProblem, 1);
  chain(freeDevice, closeLoan, mailDone, repairIf);
  link(repairIf, itRepair, 0);
});

for (const [file, wf] of [['1-request.json', request], ['2-daily-reminders.json', reminders], ['3-return.json', ret]]) {
  writeFileSync(new URL(`workflows/${file}`, root), JSON.stringify(wf, null, 2) + '\n');
  console.log(`workflows/${file}: ${wf.nodes.length} nodes`);
}
