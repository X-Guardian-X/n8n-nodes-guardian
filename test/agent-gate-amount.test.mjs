// Unit test: normalizeAgentGatePayload's Amount-field vs Payload-JSON merge.
//
// The Amount field defaults to 0 in the UI, so n8n always returns 0 for an
// untouched field — indistinguishable from a deliberate "set amount to 0".
// Rule: a 0 Amount field defers to an existing payload.amount from the JSON;
// any non-zero Amount field wins, same as before this test existed.
//
// Pure function, no I/O — imports the compiled function directly, no
// IExecuteFunctions mock or fetch stub needed (unlike the other test/*.mjs
// files in this package).

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeAgentGatePayload } = require('../dist/nodes/Guardian/Guardian.node.js');

let passed = 0;
function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
	passed++;
	console.log(`✅ ${message}`);
}

// 1. payload.amount=5000, Amount field untouched (0) → keep the JSON amount.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		payload: { amount: 5000 },
		amount: 0,
	});
	assertEqual(result.amount, 5000, 'untouched Amount (0) + payload.amount=5000 → keeps 5000');
}

// 2. payload.amount=5000, Amount field set to 100 → the field wins.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		payload: { amount: 5000 },
		amount: 100,
	});
	assertEqual(result.amount, 100, 'Amount field set to 100 + payload.amount=5000 → field wins, 100');
}

// 3. payload without amount, Amount 0 → amount ends up 0.
// There is nothing in the JSON to defer to, so 0 is written — the field is
// the only source of truth here, and 0 is a value the sender could
// legitimately mean (a $0 transaction), not an absence.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		payload: {},
		amount: 0,
	});
	assertEqual(result.amount, 0, 'no payload.amount + Amount 0 → amount is 0 (field is the only source)');
}

// 4. no payload, Amount 250 → 250.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		amount: 250,
	});
	assertEqual(result.amount, 250, 'no payload + Amount 250 → amount is 250');
}

console.log(`\n${passed} assertions passed.`);
