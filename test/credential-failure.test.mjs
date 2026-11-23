// Unit test: a Guardian credential that cannot be resolved at run time
// (e.g. deleted) must never let an item reach the Allowed output.
//
// Bug (found by an outside tester on n8n 2.47.7, confirmed by reading the
// code): `this.getCredentials('guardianApi')` and the first
// `this.getNodeParameter('resource', ...)` read both ran OUTSIDE the
// per-item try/catch in Guardian.node.ts's execute(). If getCredentials
// threw (CredentialNotFoundError), the error escaped execute() entirely —
// with On Error = Continue (regular output), n8n then places the resulting
// error item on output 0 ("Allowed"), since nothing inside the node ever
// got a chance to route it to Denied. The workflow would continue to the
// real action with no Guardian record and no alarm: a fail-open.
//
// Fix: getCredentials is now read in its own try/catch, before the
// per-item loop. On failure: continueOnFail() true -> every input item is
// denied with decision ERROR (nothing on Allowed, nothing on Needs
// Approval); continueOnFail() false -> throws NodeOperationError, same as
// every other failure in this node. The resource parameter read was also
// moved inside the per-item try, so a failure reading it is denied per-item
// instead of escaping before that item's try/catch exists.
//
// Drives the compiled dist/ node with the same mocked IExecuteFunctions +
// stubbed fetch pattern as test/killswitch-enforce.test.mjs.

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

function makeContext({ itemCount = 1, params = {}, getCredentialsImpl, continueOnFail = true } = {}) {
	const items = Array.from({ length: itemCount }, () => ({ json: {} }));
	return {
		getInputData: () => items,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCredentials: getCredentialsImpl ?? (async () => ({ baseUrl: 'https://api.guardian.test', apiKey: 'k' })),
		getNode: () => ({ name: 'Guardian', type: 'n8n-nodes-guardian.guardian' }),
		getExecutionId: () => 'exec-1',
		continueOnFail: () => continueOnFail,
	};
}

const node = new Guardian();

// ── 1. getCredentials throws, continueOnFail true, 3 input items ─────────
{
	const [allowed, denied, approval] = await node.execute.call(makeContext({
		itemCount: 3,
		continueOnFail: true,
		getCredentialsImpl: async () => { throw new Error('Credential "guardianApi" could not be found'); },
	}));

	assertEqual(allowed.length, 0, 'credential failure (continueOnFail): 0 items on Allowed');
	assertEqual(denied.length, 3, 'credential failure (continueOnFail): 3 items on Denied');
	assertEqual(approval.length, 0, 'credential failure (continueOnFail): 0 items on Needs Approval');

	denied.forEach((item, idx) => {
		assertEqual(item.json._guardian.decision, 'ERROR', `credential failure item ${idx}: _guardian.decision is ERROR`);
		assertTrue(
			typeof item.json.error === 'string' && item.json.error.includes('could not be found'),
			`credential failure item ${idx}: error message is the credential error`,
		);
		assertEqual(item.pairedItem.item, idx, `credential failure item ${idx}: pairedItem.item is ${idx}`);
	});
}

// ── 2. getCredentials throws, continueOnFail false -> execute() throws ───
{
	let threw = false;
	try {
		await node.execute.call(makeContext({
			itemCount: 2,
			continueOnFail: false,
			getCredentialsImpl: async () => { throw new Error('Credential "guardianApi" could not be found'); },
		}));
	} catch (error) {
		threw = true;
		assertTrue(
			error.message.includes('could not be found'),
			'credential failure (continueOnFail false): thrown error carries the original message',
		);
	}
	assertTrue(threw, 'credential failure (continueOnFail false): execute() throws instead of returning');
}

// ── 3. Normal credential, mocked ALLOW response -> unchanged behaviour ───
{
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/v1/intents/check')) {
			return { status: 200, body: { decision: 'ALLOW', intentRunId: 'intent-1' } };
		}
		if (method === 'POST' && url.includes('/execute')) {
			return { status: 200, body: { executed: true, executedAt: '2026-01-01T00:00:00.000Z' } };
		}
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};

	const [allowed, denied, approval] = await node.execute.call(makeContext({
		itemCount: 1,
		continueOnFail: true,
		params: {
			resource: 'check',
			operation: 'evaluateAndExecute',
			actionType: 'payment.send',
			payload: { amount: 100 },
		},
	}));

	assertEqual(allowed.length, 1, 'normal credential + ALLOW: exactly one item on Allowed');
	assertEqual(denied.length, 0, 'normal credential + ALLOW: 0 items on Denied');
	assertEqual(approval.length, 0, 'normal credential + ALLOW: 0 items on Needs Approval');
	assertEqual(allowed[0].json._guardian.decision, 'ALLOW', 'normal credential + ALLOW: decision is ALLOW (unchanged behaviour)');
}

console.log(`\n${passed} assertions passed.`);
