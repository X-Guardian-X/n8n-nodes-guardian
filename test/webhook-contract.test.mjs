// Behavioral contract test: GuardianApprovalTrigger vs contracts/notification-webhook.json.
//
// Drives the compiled trigger's webhookMethods with a mocked IHookFunctions
// context and a stubbed global fetch, then asserts each contract clause
// against the canonical artifact — not against source strings. If the node
// and the contract disagree, this test fails; if the contract changes
// deliberately, update contracts/notification-webhook.json and this test
// follows it.
//
// The backend side of this contract (route accepts ownership fields, unique
// constraints, migration) is asserted in GUARDIAN_V1 backend tests, which
// reference the same artifact.

import { createRequire } from 'module';
import { createHmac } from 'crypto';

const require = createRequire(import.meta.url);
const contract = require('../contracts/notification-webhook.json');
const { GuardianApprovalTrigger } = require('../dist/nodes/GuardianApprovalTrigger/GuardianApprovalTrigger.node.js');

const trigger = new GuardianApprovalTrigger();
const BASE = 'https://api.guardian.test';
const WF_ID = 'wf-1';
const NODE_ID = 'node-1';
const WEBHOOK_URL = `https://n8n.test/webhook/${contract.webhookEndpoint.pathTemplate
	.replace('{workflowId}', WF_ID)
	.replace('{nodeId}', NODE_ID)}`;

let passed = 0;
function assertTrue(condition, message) {
	if (!condition) throw new Error(`❌ ${message}`);
	passed++;
	console.log(`✅ ${message}`);
}

// ── fetch stub: records calls, returns canned API responses ─────────────
let calls = [];
let listResponse = { webhooks: [] };
let postCounter = 0;
globalThis.fetch = async (url, opts = {}) => {
	const u = String(url);
	const method = opts.method ?? 'GET';
	calls.push({ method, url: u, body: opts.body ? JSON.parse(opts.body) : undefined });
	let payload = {};
	if (method === 'GET' && u.endsWith(contract.list.path)) {
		payload = listResponse;
	} else if (method === 'POST' && u.endsWith(contract.registration.path)) {
		const body = calls[calls.length - 1].body;
		payload = { webhook: { id: `wh-new-${++postCounter}`, url: body.url, events: body.events, enabled: true } };
	}
	return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) };
};

function reset({ webhooks = [] } = {}) {
	calls = [];
	listResponse = { webhooks };
	postCounter = 0;
}

// ── Mocked n8n hook/webhook context ─────────────────────────────────────
const node = {
	id: NODE_ID,
	name: 'Guardian Approval Trigger',
	type: 'n8n-nodes-guardian.guardianApprovalTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function makeCtx({ staticData = {}, params = {}, body = {}, headers = {}, rawBody, response } = {}) {
	return {
		getCredentials: async () => ({ baseUrl: BASE, apiKey: 'gk_test', signingSecret: 'gs_test' }),
		getNode: () => node,
		getWorkflow: () => ({ id: WF_ID }),
		getNodeWebhookUrl: () => WEBHOOK_URL,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		logger: { error() {}, warn() {}, info() {} },
		getBodyData: () => body,
		getHeaderData: () => headers,
		getRequestObject: () => ({ rawBody }),
		getResponseObject: () => response,
	};
}

function mockResponse() {
	const res = {
		statusCode: null,
		body: null,
		status(code) { res.statusCode = code; return res; },
		send(b) { res.body = b; return res; },
		end() { res.ended = true; return res; },
	};
	return res;
}

const { checkExists, create, delete: deleteHook } = trigger.webhookMethods.default;

console.log('\n🧪 Webhook contract conformance (contracts/notification-webhook.json)\n');

// ── 1. Endpoint template binds workflow + node identity ────────────────
const hook = trigger.description.webhooks[0];
assertTrue(
	hook.path === contract.webhookEndpoint.n8nExpression,
	`webhook path template binds ${contract.webhookEndpoint.mustBind.join(' + ')}`,
);
assertTrue(
	hook.httpMethod === contract.webhookEndpoint.httpMethod && hook.responseMode === contract.webhookEndpoint.responseMode,
	`webhook endpoint is ${contract.webhookEndpoint.httpMethod}/${contract.webhookEndpoint.responseMode}`,
);

// ── 2. registerOwnership: POST carries all required contract fields ────
reset();
{
	const staticData = {};
	const ok = await create.call(makeCtx({ staticData }));
	const post = calls.find((c) => c.method === contract.registration.method && c.url === `${BASE}${contract.registration.path}`);
	assertTrue(
		ok && Boolean(post),
		`create() registers via ${contract.registration.method} ${contract.registration.path}`,
	);
	assertTrue(
		contract.registration.requiredBodyFields.every((f) => post.body[f] !== undefined) &&
			post.body.workflowId === WF_ID &&
			post.body.nodeId === NODE_ID &&
			JSON.stringify(post.body.events) === JSON.stringify(contract.registration.events),
		`registration body carries ownership (${contract.registration.requiredBodyFields.join(', ')})`,
	);
}

// ── 3. deleteStaleUrlBeforeRegister ────────────────────────────────────
reset();
{
	const staticData = { webhookId: 'wh-old', webhookSecret: 's', webhookUrl: 'https://old.tunnel.example/hook' };
	await create.call(makeCtx({ staticData }));
	const delIdx = calls.findIndex((c) => c.method === contract.delete.method && c.url.endsWith('/v1/admin/webhooks/wh-old'));
	const postIdx = calls.findIndex((c) => c.method === 'POST');
	assertTrue(
		delIdx !== -1 && postIdx !== -1 && delIdx < postIdx,
		'create() DELETEs the stored registration before re-registering when the URL changed',
	);
}

// ── 4. preserveSameUrlRegistrations — fail closed ─────────────────────
// A registration belonging to a still-active workflow must never be
// deleted as collateral. If a same-URL row exists that this node does not
// own, create() must leave it intact (flag it) and let the backend decide.
reset({ webhooks: [{ id: 'wh-dup', url: WEBHOOK_URL, enabled: true, events: ['approval_resolved'] }] });
{
	await create.call(makeCtx({ staticData: {} }));
	assertTrue(
		!calls.some((c) => c.method === contract.delete.method && c.url.endsWith('/v1/admin/webhooks/wh-dup')),
		'create() must NOT DELETE an existing registration holding the same URL',
	);
	assertTrue(
		calls.some((c) => c.method === 'POST'),
		'create() still registers after declining to delete the same-URL row',
	);
}

// ── 4b. failed registration must not leave the org de-registered ───────
// The dangerous sequence this guards against: delete live row, then POST
// fails → workflow published but nothing registered. With deletions
// banned in create(), a failing POST can never orphan the workflow.
reset({ webhooks: [{ id: 'wh-live', url: WEBHOOK_URL, enabled: true, events: ['approval_resolved'], workflowId: WF_ID, nodeId: NODE_ID }] });
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts = {}) => {
		const u = String(url);
		const method = opts.method ?? 'GET';
		calls.push({ method, url: u, body: opts.body ? JSON.parse(opts.body) : undefined });
		if (method === 'GET' && u.endsWith(contract.list.path)) return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(listResponse) };
		if (method === 'POST' && u.endsWith(contract.registration.path)) return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ error: 'ACTION_TYPE_ALREADY_BOUND' }) };
		if (method === 'DELETE') return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
		return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
	};
	try {
		let threw = false;
		try {
			await create.call(makeCtx({ staticData: {} }));
		} catch {
			threw = true;
		}
		assertTrue(threw, 'create() surfaces a failed registration POST');
		assertTrue(
			!calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/admin/webhooks/wh-live')),
			'create() issued no DELETE — the live registration survives a failed re-registration',
		);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// ── 5. reRegisterLegacy: missing/mismatched ownership forces re-create ─
reset({
	webhooks: [{
		id: 'wh-1', url: WEBHOOK_URL, enabled: true,
		events: ['approval_resolved'], workflowId: 'other-wf', nodeId: NODE_ID,
	}],
});
{
	const staticData = { webhookId: 'wh-1', webhookSecret: 's' };
	const exists = await checkExists.call(makeCtx({ staticData }));
	assertTrue(exists === false, 'checkExists() rejects a registration whose stored ownership does not match');
}
reset({
	webhooks: [{
		id: 'wh-1', url: WEBHOOK_URL, enabled: true,
		events: ['approval_resolved'], workflowId: WF_ID, nodeId: NODE_ID,
	}],
});
{
	const staticData = { webhookId: 'wh-1', webhookSecret: 's' };
	const exists = await checkExists.call(makeCtx({ staticData }));
	assertTrue(exists === true, 'checkExists() accepts a healthy registration with matching ownership');
}

// ── 6. deleteOnDeactivate ──────────────────────────────────────────────
reset();
{
	const staticData = { webhookId: 'wh-9', webhookSecret: 's', webhookUrl: WEBHOOK_URL };
	await deleteHook.call(makeCtx({ staticData }));
	assertTrue(
		calls.some((c) => c.method === contract.delete.method && c.url.endsWith('/v1/admin/webhooks/wh-9')) &&
			staticData.webhookId === undefined,
		'delete() removes the registration on deactivate and clears static data',
	);
}

// ── 7. verifyHmacSignature ─────────────────────────────────────────────
{
	const secret = 'whs_testsecret';
	const body = { event: 'approval_resolved', status: 'APPROVED', intentRunId: 'ir-1' };
	const rawBody = JSON.stringify(body);
	const goodSig = createHmac('sha256', secret).update(rawBody).digest('hex');
	const staticData = { webhookSecret: secret };

	const badRes = mockResponse();
	const badResult = await trigger.webhook.call(
		makeCtx({ staticData, body, rawBody, headers: { 'x-guardian-webhook-signature': 'deadbeef' }, response: badRes }),
	);
	assertTrue(
		badRes.statusCode === 401 && badResult.noWebhookResponse === true,
		'delivery with invalid signature is rejected with 401',
	);

	const goodRes = mockResponse();
	const goodResult = await trigger.webhook.call(
		makeCtx({ staticData, body, rawBody, headers: { 'x-guardian-webhook-signature': goodSig }, response: goodRes }),
	);
	assertTrue(
		goodResult.workflowData?.[0]?.[0]?.json?._guardianWebhook?.verified === true,
		'delivery with valid signature emits verified workflow data',
	);
}

console.log(`\nResults: ${passed} passed, 0 failed\n`);
