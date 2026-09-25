// Behavioral test: execution-claim attribution for already-claimed intents.
//
// An idempotent:true response from POST /v1/intents/:id/execute means "the
// single execution claim on this intent is already consumed." That splits
// into two cases the node must distinguish:
//
//   - self-claim: the stored idempotency key was minted by THIS n8n workflow
//     execution (n8n-exec:<thisExecutionId>:...) — e.g. an Agent Gate
//     Evaluate & Claim earlier in the same run. Not a denial: routes to
//     Allowed with executed:false + alreadyClaimed:true.
//   - foreign claim: any other stored key — another execution owns the claim.
//     Exactly-once protection: routes to Denied, but the recorded decision
//     must remain ALLOW (the policy verdict is not falsified).
//
// Drives the compiled dist/ node with a mocked IExecuteFunctions context and
// a stubbed global fetch, matching test/webhook-contract.test.mjs.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Guardian } = require('../dist/nodes/Guardian/Guardian.node.js');

const EXECUTION_ID = 'exec-1';
const SELF_KEY = `n8n-exec:${EXECUTION_ID}:abc123def456`;
const FOREIGN_KEY = 'n8n-exec:other-run:zzz999';
const CUSTOM_KEY = 'user-supplied-key';

let passed = 0;
function assertTrue(condition, message) {
	if (!condition) throw new Error(`❌ ${message}`);
	passed++;
	console.log(`✅ ${message}`);
}

// ── fetch stub: dispatch on method+path, scenarios set `responder` ──────
let responder = () => ({ status: 500, body: { error: 'no responder' } });
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
	const method = opts.method ?? 'GET';
	calls.push({ method, url: String(url), body: opts.body ? JSON.parse(opts.body) : undefined });
	const r = responder(method, String(url));
	return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
};

function makeContext(params, inputJson = {}) {
	return {
		getInputData: () => [{ json: inputJson }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => ({ baseUrl: 'https://api.guardian.test', apiKey: 'k' }),
		getNode: () => ({ name: 'Guardian', type: 'n8n-nodes-guardian.guardian' }),
		getExecutionId: () => EXECUTION_ID,
	};
}

const INTENT_ID = 'intent-1';
function intentGet(overrides = {}) {
	return {
		decision: 'ALLOW',
		status: 'DECIDED',
		actionType: 'email.send',
		intentRunId: INTENT_ID,
		idempotencyKey: SELF_KEY,
		payloadJson: { recipient: 'a@b.c', subject: 's', body: 'b' },
		...overrides,
	};
}
const IDEMPOTENT_EXEC = {
	decision: 'ALLOW',
	executed: true,
	idempotent: true,
	executedAt: '2026-09-25T06:20:03.000Z',
	intentRunId: INTENT_ID,
};

const node = new Guardian();

async function runEnforce({ get, exec }) {
	responder = (method, url) => {
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: get };
		if (method === 'POST' && url.includes('/execute')) return { status: 200, body: exec };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	return node.execute.call(makeContext({
		resource: 'enforce',
		enforceIntentRunId: INTENT_ID,
		enforceOperation: 'claim',
	}));
}

// ── Enforce: fresh claim → Allowed, executed ─────────────────────────────
{
	const [allowed, denied, approval] = await runEnforce({ get: intentGet(), exec: { decision: 'ALLOW', executed: true, executedAt: 't' } });
	assertTrue(allowed.length === 1 && denied.length === 0 && approval.length === 0, 'enforce fresh claim → Allowed branch');
	assertTrue(allowed[0].json._guardian.executed === true, 'enforce fresh claim: executed=true');
	assertTrue(allowed[0].json._guardian.executionClaimed === true, 'enforce fresh claim: executionClaimed=true');
}

// ── Enforce: self-claim → Allowed with executed:false (the reported bug) ─
{
	const [allowed, denied] = await runEnforce({ get: intentGet(), exec: IDEMPOTENT_EXEC });
	assertTrue(allowed.length === 1 && denied.length === 0, 'enforce self-claim → Allowed branch (not Denied)');
	assertTrue(allowed[0].json._guardian.decision === 'ALLOW', 'enforce self-claim: decision stays ALLOW');
	assertTrue(allowed[0].json._guardian.executed === false, 'enforce self-claim: executed=false');
	assertTrue(allowed[0].json._guardian.alreadyClaimed === true, 'enforce self-claim: alreadyClaimed=true');
	assertTrue(allowed[0].json._guardian.executionClaimed === false, 'enforce self-claim: executionClaimed=false');
	assertTrue(!allowed[0].json.error, 'enforce self-claim: no error recorded');
}

// ── Enforce: foreign claim → Denied, truthful decision ───────────────────
for (const key of [FOREIGN_KEY, CUSTOM_KEY]) {
	const [allowed, denied] = await runEnforce({ get: intentGet({ idempotencyKey: key }), exec: IDEMPOTENT_EXEC });
	assertTrue(denied.length === 1 && allowed.length === 0, `enforce foreign claim (${key.slice(0, 9)}…) → Denied branch`);
	assertTrue(denied[0].json._guardian.decision === 'ALLOW', 'enforce foreign claim: decision still ALLOW, not falsified');
	assertTrue(denied[0].json._guardian.duplicateBlocked === true, 'enforce foreign claim: duplicateBlocked=true');
	assertTrue(denied[0].json._guardian.executed === false, 'enforce foreign claim: executed=false');
	assertTrue(typeof denied[0].json.error === 'string', 'enforce foreign claim: error explains the block');
}

// ── Enforce: genuine DENY → Denied; REQUIRE_APPROVAL → approval ──────────
{
	const [allowed, denied] = await runEnforce({ get: intentGet({ decision: 'DENY' }), exec: {} });
	assertTrue(denied.length === 1 && allowed.length === 0, 'enforce DENY → Denied branch');
	const [a2, d2, ap2] = await runEnforce({ get: intentGet({ decision: 'REQUIRE_APPROVAL', status: 'AWAITING_APPROVAL' }), exec: {} });
	assertTrue(ap2.length === 1 && allowed.length === 0, 'enforce REQUIRE_APPROVAL → approval branch');
}

// ── Check → Evaluate & Execute: self vs foreign ──────────────────────────
async function runEvalExec(storedKey) {
	responder = (method, url) => {
		if (method === 'POST' && url.endsWith('/v1/intents/check')) {
			return { status: 200, body: { decision: 'ALLOW', intentRunId: INTENT_ID, idempotencyKey: storedKey } };
		}
		if (method === 'POST' && url.includes('/execute')) return { status: 200, body: IDEMPOTENT_EXEC };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	return node.execute.call(makeContext({
		resource: 'check',
		operation: 'evaluateAndExecute',
		actionType: 'email.send',
		payload: '{"recipient":"a@b.c"}',
	}));
}
{
	const [allowed, denied] = await runEvalExec(SELF_KEY);
	assertTrue(allowed.length === 1 && denied.length === 0, 'check evaluateAndExecute self-claim → Allowed');
	assertTrue(allowed[0].json._guardian.executed === false && allowed[0].json._guardian.alreadyClaimed === true, 'check self-claim: executed=false, alreadyClaimed=true');
	const [a2, d2] = await runEvalExec(CUSTOM_KEY);
	assertTrue(d2.length === 1 && a2.length === 0, 'check evaluateAndExecute foreign claim → Denied');
	assertTrue(d2[0].json._guardian.decision === 'ALLOW' && d2[0].json._guardian.duplicateBlocked === true, 'check foreign claim: truthful ALLOW + duplicateBlocked');
}

// ── Check → Execute op: attributes via GET on the idempotent path ────────
async function runExecuteOp(storedKey) {
	responder = (method, url) => {
		if (method === 'POST' && url.includes('/execute')) return { status: 200, body: IDEMPOTENT_EXEC };
		if (method === 'GET' && url.includes(`/v1/intents/${INTENT_ID}`)) return { status: 200, body: intentGet({ idempotencyKey: storedKey }) };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	return node.execute.call(makeContext({
		resource: 'check',
		operation: 'execute',
		intentRunId: INTENT_ID,
	}));
}
{
	calls = [];
	const [allowed, denied] = await runExecuteOp(SELF_KEY);
	assertTrue(allowed.length === 1 && denied.length === 0, 'check execute self-claim → Allowed');
	assertTrue(allowed[0].json._guardian.alreadyClaimed === true, 'check execute self-claim: alreadyClaimed=true');
	assertTrue(calls.some((c) => c.method === 'GET'), 'check execute: GET issued to attribute claim');
	const [a2, d2] = await runExecuteOp(FOREIGN_KEY);
	assertTrue(d2.length === 1 && a2.length === 0, 'check execute foreign claim → Denied');
	assertTrue(d2[0].json._guardian.decision === 'ALLOW', 'check execute foreign: decision truthful');
}

// ── Agent Gate: unchanged — in-run re-invocation stays blocked ───────────
{
	responder = (method, url) => {
		if (method === 'POST' && url.endsWith('/v1/intents/check')) {
			return { status: 200, body: { decision: 'ALLOW', intentRunId: INTENT_ID } };
		}
		if (method === 'POST' && url.includes('/execute')) return { status: 200, body: IDEMPOTENT_EXEC };
		return { status: 500, body: { error: `unexpected ${method} ${url}` } };
	};
	const [allowed] = await node.execute.call(makeContext({
		resource: 'agentGate',
		agentGateOperation: 'evaluateAndClaim',
		agentActionType: 'email.send',
		agentPayload: {},
		agentRecipient: 'a@b.c',
	}));
	assertTrue(allowed.length === 1, 'agentGate idempotent → still returns on tool output');
	assertTrue(allowed[0].json.duplicateBlocked === true && allowed[0].json.canProceed === false, 'agentGate idempotent: duplicateBlocked + canProceed=false (unchanged)');
}

console.log(`\n${passed} assertions passed.`);
