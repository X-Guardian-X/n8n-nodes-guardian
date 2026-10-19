// Unit test: Enforce (claim) resource vs. the execute-time kill switch
// 403 (fix 3).
//
// Backend returns the IDENTICAL shape for GLOBAL and project-scoped kill
// switches at POST /v1/intents/:id/execute: 403 { error: 'INCIDENT_MODE' }
// — no `decision`/`reason` field (verified directly against
// backend/src/routes/intents.ts's execute handler; confirmed in this
// session's investigation report). Before this fix, the Enforce resource's
// execute-claim call had no local error handling, so this 403 (triggered
// whenever an intent's ALLOW was stored BEFORE the kill switch activated —
// the GET step above it correctly handles the OTHER timing, where the kill
// switch was already active when /check ran) threw a raw, opaque
// NodeApiError instead of routing to Denied with a reason, for both scopes
// equally.
//
// Drives the compiled dist/ node with the same mocked IExecuteFunctions +
// stubbed fetch pattern as test/claim-attribution.test.mjs.

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
		// Default (Continue on Fail OFF) for the 401/5xx/other-403 cases below,
		// which must still throw out of node.execute — matching the real
		// outer try/catch at the bottom of the 'enforce' resource.
		continueOnFail: () => false,
	};
}

const INTENT_ID = 'intent-1';
// Stale ALLOW stored at /check time, before the kill switch (of either
// scope) activated — the exact timing this fix targets. The GET step maps
// this straight through as ALLOW/DECIDED, so Enforce proceeds to the
// execute-claim call, which is where the now-active kill switch is
// actually enforced.
const ALLOWED_INTENT = {
	decision: 'ALLOW',
	status: 'DECIDED',
	actionType: 'billing.send_payment',
	intentRunId: INTENT_ID,
	payloadJson: { amount: 100 },
};

const node = new Guardian();

async function runEnforceClaim() {
	return node.execute.call(makeContext({
		resource: 'enforce',
		enforceIntentRunId: INTENT_ID,
		enforceOperation: 'claim',
	}));
}

// ── Kill switch 403 at execute time (identical shape for GLOBAL and
//    project-scoped — only testing the one shape, since the backend does
//    not distinguish) → Denied, with a reason, not a thrown error ────────
for (const scopeLabel of ['GLOBAL', 'project-scoped']) {
	responder = (method, url) => {
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: ALLOWED_INTENT };
		if (method === 'POST' && url.includes('/execute')) return { status: 403, body: { error: 'INCIDENT_MODE' } };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed, denied] = await runEnforceClaim();
	assertTrue(denied.length === 1 && allowed.length === 0, `${scopeLabel} kill switch 403 at execute → Denied branch (not thrown)`);
	assertTrue(typeof denied[0].json.error === 'string' && denied[0].json.error.length > 0, `${scopeLabel} kill switch 403 → Denied item carries a non-empty reason`);
	assertTrue(denied[0].json.error.includes('kill switch'), `${scopeLabel} kill switch 403 → reason mentions the kill switch`);
	assertEqual(denied[0].json._guardian.executionClaimed, false, `${scopeLabel} kill switch 403 → executionClaimed is false`);
}

// ── Every other execute-time failure keeps today's behaviour: rethrown,
//    caught only by the resource's outer try/catch (continueOnFail() off
//    by default in this mock → throws out of node.execute) ──────────────

// 401 (bad API key)
{
	responder = (method, url) => {
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: ALLOWED_INTENT };
		if (method === 'POST' && url.includes('/execute')) return { status: 401, body: { error: 'Invalid API key' } };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	let threw = false;
	try {
		await runEnforceClaim();
	} catch (error) {
		threw = true;
		assertTrue(error.message.includes('401'), '401 at execute → still throws, message includes status (unchanged behavior)');
	}
	assertTrue(threw, '401 at execute → still throws (not silently routed to Denied)');
}

// 5xx
{
	responder = (method, url) => {
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: ALLOWED_INTENT };
		if (method === 'POST' && url.includes('/execute')) return { status: 500, body: { error: 'Internal error' } };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	let threw = false;
	try {
		await runEnforceClaim();
	} catch (error) {
		threw = true;
		assertTrue(error.message.includes('500'), '5xx at execute → still throws, message includes status (unchanged behavior)');
	}
	assertTrue(threw, '5xx at execute → still throws');
}

// A different 403 shape that DOES carry a decision/reason (e.g.
// break-glass-admin-required) must NOT be mistaken for the kill switch —
// it keeps today's behaviour (throws), since it isn't the specific
// INCIDENT_MODE/no-decision shape this fix targets.
{
	responder = (method, url) => {
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: ALLOWED_INTENT };
		if (method === 'POST' && url.includes('/execute')) {
			return { status: 403, body: { decision: 'DENY', reason: 'Break-glass mode requires ADMIN role', error: 'ADMIN_REQUIRED_FOR_BREAK_GLASS' } };
		}
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	let threw = false;
	try {
		await runEnforceClaim();
	} catch (error) {
		threw = true;
	}
	assertTrue(threw, 'a different 403 shape (has a decision field) is not mistaken for the kill switch — still throws, unchanged');
}

console.log(`\n${passed} assertions passed.`);
