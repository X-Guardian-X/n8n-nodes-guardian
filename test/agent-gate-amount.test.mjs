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
const { normalizeAgentGatePayload, Guardian } = require('../dist/nodes/Guardian/Guardian.node.js');

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

// ── Fix: the Amount field's declared UI default changed from 0 to '' ──────
// (Guardian.node.ts ~line 444), so an untouched field now reaches this
// function as `amount: undefined`, not `amount: 0` — see the amountRaw/
// amount conversion at Guardian.node.ts ~line 982-983. Cases 1-4 above still
// hold: `amount: 0` passed into this function now ALWAYS means a genuinely
// deliberate 0 (the UI can no longer produce 0 for "untouched"). These two
// cases cover the untouched case itself, now correctly represented.

// 5. no payload.amount, Amount field untouched (amount: undefined) →
//    amount must never be written as 0 — it must stay absent entirely.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		payload: {},
		amount: undefined,
	});
	assertEqual(result.amount, undefined, 'no payload.amount + Amount untouched (undefined) → amount is never defaulted to 0');
	assertEqual('amount' in result, false, 'no payload.amount + Amount untouched → "amount" key is absent, not present-and-0');
}

// 6. payload.amount=5000, Amount field untouched (amount: undefined) →
//    the 1.0.9 fix, re-verified under the corrected "untouched" semantics.
{
	const result = normalizeAgentGatePayload({
		actionType: 'payment.send',
		payload: { amount: 5000 },
		amount: undefined,
	});
	assertEqual(result.amount, 5000, '1.0.9 fix still holds: payload.amount=5000 + Amount untouched (undefined) → keeps 5000');
}

// ── Guard against the regression recurring: the pure-function cases above
// can't by themselves catch a revert of the UI field's declared default —
// n8n stores a declared numeric default as the field's real stored value
// the moment the node is created, which is the actual root cause this fix
// addresses (not something the normalizeAgentGatePayload cases exercise).
{
	const node = new Guardian();
	const prop = node.description.properties.find((p) => p.name === 'agentAmount');
	assertEqual(prop.default, '', 'Amount field (agentAmount) declared default is "" (empty), not 0 — regression guard');
}

console.log(`\n${passed} assertions passed.`);
