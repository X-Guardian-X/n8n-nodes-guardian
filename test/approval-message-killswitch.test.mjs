// Unit tests for two 1.0.11 fixes:
//
// Fix A — Agent Gate's REQUIRE_APPROVAL message. An AI agent previously read
// "This action requires human approval. It has been submitted for approval."
// as its own mistake and re-called the tool. The message now explicitly says
// it's not an error, includes the intentRunId, and tells the agent to stop —
// plus a machine-readable `nextStep: 'wait_for_approval'` field. Wording only
// — decision/canProceed/outputs/idempotency key are unchanged. Covers both
// Agent Gate operations (evaluate, evaluateAndClaim): the REQUIRE_APPROVAL
// branch runs before the operation split, so one code path serves both.
//
// Fix B — project/global kill switch active at /check time. Backend returns
// HTTP 403 with a REAL DENY decision body (decision: 'DENY', reason:
// 'INCIDENT_MODE', intentRunId, status, payloadHash) — a genuine Guardian
// verdict, not a failed request. Before this fix, the check resource (both
// evaluate and evaluateAndExecute) and Agent Gate treated this as a thrown
// error (decision ERROR). Now it's routed as a normal DENY: Denied output
// for the check resource, allowedItems (decision: 'DENY') for Agent Gate —
// Agent Gate's single-output AI-tool pattern, same as its existing
// OBSERVED/DENY/REQUIRE_APPROVAL/ALLOW branches. Every other error shape
// (403 without a decision field, 401, 5xx, network, timeout) is unchanged —
// the Enforce resource's own kill-switch handling (Guardian.node.ts
// ~925-956) is untouched and not exercised here.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Guardian } = require('../dist/nodes/Guardian/Guardian.node.js');

let passed = 0;
function assertTrue(condition, message) {
	if (!condition) throw new Error(`❌ ${message}`);
	passed++;
	console.log(`✅ ${message}`);
}
function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
	passed++;
	console.log(`✅ ${message}`);
}

let responder = () => ({ status: 500, body: { error: 'no responder' } });
globalThis.fetch = async (url, opts = {}) => {
	const method = opts.method ?? 'GET';
	const r = responder(method, String(url));
	return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
};

function makeContext(params) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => ({ baseUrl: 'https://api.guardian.test', apiKey: 'k' }),
		getNode: () => ({ name: 'Guardian', type: 'n8n-nodes-guardian.guardian' }),
		getExecutionId: () => 'exec-1',
		continueOnFail: () => false,
	};
}

const node = new Guardian();
const INTENT_ID = 'intent-approval-1';
const KILLSWITCH_INTENT_ID = 'intent-ks-1';

// ═══════════════════════════════════════════════════════════════════════
// Fix A — Agent Gate REQUIRE_APPROVAL message + nextStep, both operations
// ═══════════════════════════════════════════════════════════════════════

const REQUIRE_APPROVAL_RESPONSE = { decision: 'REQUIRE_APPROVAL', intentRunId: INTENT_ID };

for (const operation of ['evaluate', 'evaluateAndClaim']) {
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 200, body: REQUIRE_APPROVAL_RESPONSE };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed] = await node.execute.call(makeContext({
		resource: 'agentGate',
		agentGateOperation: operation,
		agentActionType: 'payment.send',
		agentPayload: { amount: 100 },
	}));
	assertTrue(allowed.length === 1, `Agent Gate ${operation}: REQUIRE_APPROVAL → exactly one item on the normal output`);
	assertEqual(allowed[0].json.decision, 'REQUIRE_APPROVAL', `Agent Gate ${operation}: decision is unchanged (REQUIRE_APPROVAL)`);
	assertEqual(allowed[0].json.canProceed, false, `Agent Gate ${operation}: canProceed is unchanged (false)`);
	assertEqual(allowed[0].json.intentRunId, INTENT_ID, `Agent Gate ${operation}: intentRunId is unchanged`);
	assertEqual(
		allowed[0].json.message,
		`Not an error. This action is waiting for human approval (request ${INTENT_ID}). Do not call this tool again for the same action. Tell the user it is waiting for approval and stop.`,
		`Agent Gate ${operation}: message is the exact new wording with the real intentRunId filled in`,
	);
	assertEqual(allowed[0].json.nextStep, 'wait_for_approval', `Agent Gate ${operation}: nextStep field is "wait_for_approval"`);
}

// ═══════════════════════════════════════════════════════════════════════
// Fix B — kill switch 403 (decision: DENY) at /check time
// ═══════════════════════════════════════════════════════════════════════

const KILLSWITCH_CHECK_BODY = {
	decision: 'DENY',
	reason: 'INCIDENT_MODE',
	intentRunId: KILLSWITCH_INTENT_ID,
	status: 'DENIED',
	payloadHash: 'abc123',
};

// -- check resource, operation evaluate --
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 403, body: KILLSWITCH_CHECK_BODY };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed, denied] = await node.execute.call(makeContext({
		resource: 'check',
		operation: 'evaluate',
		actionType: 'payment.send',
		payload: { amount: 100 },
	}));
	assertTrue(denied.length === 1 && allowed.length === 0, 'check/evaluate: kill switch 403 (decision DENY) → Denied output, not thrown');
	assertEqual(denied[0].json.decision, 'DENY', 'check/evaluate: kill switch → decision DENY');
	assertEqual(denied[0].json.intentRunId, KILLSWITCH_INTENT_ID, "check/evaluate: kill switch → the body's intentRunId is preserved");
	assertEqual(denied[0].json.status, 'DENIED', "check/evaluate: kill switch → the body's status is preserved");
	assertEqual(
		denied[0].json.message,
		'Guardian kill switch is active (INCIDENT_MODE). The action must not run.',
		'check/evaluate: kill switch → exact message',
	);
	assertEqual(denied[0].json._guardian.decision, 'DENY', 'check/evaluate: kill switch → _guardian.decision is DENY');
}

// -- check resource, operation evaluateAndExecute --
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 403, body: KILLSWITCH_CHECK_BODY };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed, denied] = await node.execute.call(makeContext({
		resource: 'check',
		operation: 'evaluateAndExecute',
		actionType: 'payment.send',
		payload: { amount: 100 },
	}));
	assertTrue(denied.length === 1 && allowed.length === 0, 'check/evaluateAndExecute: kill switch 403 (decision DENY) → Denied output, not thrown');
	assertEqual(denied[0].json.decision, 'DENY', 'check/evaluateAndExecute: kill switch → decision DENY');
	assertEqual(denied[0].json.intentRunId, KILLSWITCH_INTENT_ID, "check/evaluateAndExecute: kill switch → the body's intentRunId is preserved");
	assertEqual(denied[0].json.status, 'DENIED', "check/evaluateAndExecute: kill switch → the body's status is preserved");
	assertEqual(
		denied[0].json.message,
		'Guardian kill switch is active (INCIDENT_MODE). The action must not run.',
		'check/evaluateAndExecute: kill switch → exact message',
	);
}

// -- Agent Gate --
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 403, body: KILLSWITCH_CHECK_BODY };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed] = await node.execute.call(makeContext({
		resource: 'agentGate',
		agentGateOperation: 'evaluateAndClaim',
		agentActionType: 'payment.send',
		agentPayload: { amount: 100 },
	}));
	assertTrue(allowed.length === 1, 'Agent Gate: kill switch 403 (decision DENY) → exactly one item on the normal output, not ERROR');
	assertEqual(allowed[0].json.decision, 'DENY', 'Agent Gate: kill switch → decision DENY (not ERROR)');
	assertEqual(allowed[0].json.canProceed, false, 'Agent Gate: kill switch → canProceed false');
	assertEqual(allowed[0].json.intentRunId, KILLSWITCH_INTENT_ID, "Agent Gate: kill switch → the body's intentRunId is preserved");
	assertEqual(
		allowed[0].json.message,
		'Guardian kill switch is active (INCIDENT_MODE). The action must not run.',
		'Agent Gate: kill switch → exact message',
	);
}

// ═══════════════════════════════════════════════════════════════════════
// A 403 WITHOUT a `decision` field must still throw/ERROR as before —
// this is NOT the kill-switch-DENY shape this fix targets (e.g. a plain
// auth/validation 403, or the Enforce execute-time INCIDENT_MODE shape
// which intentionally has no `decision` field and is handled separately).
// ═══════════════════════════════════════════════════════════════════════

// -- check resource: still throws --
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 403, body: { error: 'INCIDENT_MODE' } };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	let threw = false;
	try {
		await node.execute.call(makeContext({
			resource: 'check',
			operation: 'evaluate',
			actionType: 'payment.send',
			payload: { amount: 100 },
		}));
	} catch (error) {
		threw = true;
		assertTrue(error.message.includes('403'), 'check/evaluate: 403 WITHOUT decision → still throws, message includes status (unchanged)');
	}
	assertTrue(threw, 'check/evaluate: 403 WITHOUT decision → still throws (not mistaken for the kill-switch-DENY shape)');
}

// -- Agent Gate: still reports ERROR (not DENY), unchanged pre-fix behavior --
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) return { status: 403, body: { error: 'INCIDENT_MODE' } };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed] = await node.execute.call(makeContext({
		resource: 'agentGate',
		agentGateOperation: 'evaluateAndClaim',
		agentActionType: 'payment.send',
		agentPayload: { amount: 100 },
	}));
	assertEqual(allowed[0].json.decision, 'ERROR', 'Agent Gate: 403 WITHOUT decision → still ERROR, not mistaken for kill-switch DENY (unchanged)');
}

console.log(`\n${passed} assertions passed.`);
