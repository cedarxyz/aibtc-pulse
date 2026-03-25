// Tests for Agent Report Module
// Run with: node tests/agent-report.test.js

const {
  REPORT_TYPES,
  REPORT_SCHEMA,
  validateReport,
  formatReportForInbox,
} = await import('../functions/api/agent-report.js');

const TESTS = [];
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function test(name, fn) {
  TESTS.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) throw new Error(`${msg}\nExpected truthy value, got: ${value}`);
}

function assertFalse(value, msg = '') {
  if (value) throw new Error(`${msg}\nExpected falsy value, got: ${value}`);
}

function assertHasKey(obj, key, msg = '') {
  if (!(key in obj)) {
    throw new Error(`${msg}\nExpected object to have key: ${key}`);
  }
}

// --- Report Type Validation Tests ---

test('REPORT_TYPES contains expected types', () => {
  assertHasKey(REPORT_TYPES, 'CHECKIN');
  assertHasKey(REPORT_TYPES, 'ACTIVITY');
  assertHasKey(REPORT_TYPES, 'CAPABILITY');
  assertHasKey(REPORT_TYPES, 'STATUS');
  assertEqual(REPORT_TYPES.CHECKIN, 'checkin');
  assertEqual(REPORT_TYPES.ACTIVITY, 'activity');
});

test('REPORT_SCHEMA has required fields', () => {
  assertTrue(Array.isArray(REPORT_SCHEMA.required));
  assertTrue(REPORT_SCHEMA.required.includes('type'));
  assertTrue(REPORT_SCHEMA.required.includes('agentAddress'));
  assertTrue(REPORT_SCHEMA.required.includes('timestamp'));
  assertTrue(REPORT_SCHEMA.required.includes('signature'));
});

test('validateReport accepts valid checkin report', () => {
  const report = {
    type: 'checkin',
    agentAddress: 'SP1RHDCCVQ3SVV2DRSP2PJNXJCA12QE72W5C7EMFS',
    timestamp: new Date().toISOString(),
    signature: 'valid-signature-here',
  };
  
  const result = validateReport(report);
  assertTrue(result.valid, 'Should validate valid report');
});

test('validateReport accepts valid activity report with metrics', () => {
  const report = {
    type: 'activity',
    agentAddress: 'SP1RHDCCVQ3SVV2DRSP2PJNXJCA12QE72W5C7EMFS',
    timestamp: new Date().toISOString(),
    signature: 'valid-signature',
    metrics: {
      checkIns: 42,
      messagesSent: 10,
      transactions: 5,
    },
    message: 'Agent is active and running smoothly',
  };
  
  const result = validateReport(report);
  assertTrue(result.valid);
});

test('validateReport rejects invalid report type', () => {
  const report = {
    type: 'invalid_type',
    agentAddress: 'SP1RHDCCVQ3SVV2DRSP2PJNXJCA12QE72W5C7EMFS',
    timestamp: new Date().toISOString(),
    signature: 'sig',
  };
  
  const result = validateReport(report);
  assertFalse(result.valid);
  assertTrue(result.error.includes('Invalid report type'));
});

test('validateReport rejects missing required fields', () => {
  const report = {
    type: 'checkin',
    timestamp: new Date().toISOString(),
  };
  
  const result = validateReport(report);
  assertFalse(result.valid);
  assertTrue(result.error.includes('Missing required field'));
});

test('validateReport rejects invalid Stacks address', () => {
  const report = {
    type: 'checkin',
    agentAddress: 'invalid-address',
    timestamp: new Date().toISOString(),
    signature: 'sig',
  };
  
  const result = validateReport(report);
  assertFalse(result.valid);
  assertTrue(result.error.includes('Invalid Stacks address'));
});

test('validateReport rejects old timestamp', () => {
  const report = {
    type: 'checkin',
    agentAddress: 'SP1RHDCCVQ3SVV2DRSP2PJNXJCA12QE72W5C7EMFS',
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    signature: 'sig',
  };
  
  const result = validateReport(report);
  assertFalse(result.valid);
  assertTrue(result.error.includes('too old'));
});

test('validateReport accepts recent timestamp (within 5 min)', () => {
  const report = {
    type: 'checkin',
    agentAddress: 'SP1RHDCCVQ3SVV2DRSP2PJNXJCA12QE72W5C7EMFS',
    timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
    signature: 'sig',
  };
  
  const result = validateReport(report);
  assertTrue(result.valid);
});

test('validateReport rejects null input', () => {
  const result = validateReport(null);
  assertFalse(result.valid);
  assertTrue(result.error.includes('must be an object'));
});

test('validateReport rejects non-object input', () => {
  const result = validateReport('not an object');
  assertFalse(result.valid);
});

// --- Format Report Tests ---

test('formatReportForInbox produces readable message', () => {
  const report = {
    type: 'activity',
    agentAddress: 'SP1TEST',
    timestamp: '2024-01-15T12:00:00.000Z',
    metrics: {
      checkIns: 10,
      messages: 5,
    },
    message: 'All systems operational',
  };
  
  const formatted = formatReportForInbox(report);
  
  assertTrue(formatted.includes('[ACTIVITY]'));
  assertTrue(formatted.includes('Agent: SP1TEST'));
  assertTrue(formatted.includes('checkIns: 10'));
  assertTrue(formatted.includes('messages: 5'));
  assertTrue(formatted.includes('All systems operational'));
});

test('formatReportForInbox handles report without metrics', () => {
  const report = {
    type: 'checkin',
    agentAddress: 'SP1TEST',
    timestamp: '2024-01-15T12:00:00.000Z',
  };
  
  const formatted = formatReportForInbox(report);
  
  assertTrue(formatted.includes('[CHECKIN]'));
  assertTrue(formatted.includes('Agent: SP1TEST'));
});

test('formatReportForInbox handles report without message', () => {
  const report = {
    type: 'status',
    agentAddress: 'SP1TEST',
    timestamp: '2024-01-15T12:00:00.000Z',
    metrics: { status: 'healthy' },
  };
  
  const formatted = formatReportForInbox(report);
  
  assertTrue(formatted.includes('[STATUS]'));
  assertTrue(formatted.includes('status: healthy'));
});

// --- Run tests ---

async function runTests() {
  console.log('\n\x1b[36m=== Agent ReportModule Tests ===\x1b[0m\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      console.log(`${PASS} ${name}`);
      passed++;
    } catch (err) {
      console.log(`${FAIL} ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }
  
  console.log(`\n\x1b[36m=== Results ===\x1b[0m`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});