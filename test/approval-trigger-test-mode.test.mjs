// Unit test: GuardianApprovalTrigger must never touch the published
// (production) Guardian webhook registration during an n8n test run
// (Execute Workflow / chat panel in the editor).
//
// Bug (reproduced by hand 31 Oct 2026): a published workflow's Approval
// Trigger has a real Guardian registration. Starting a test run makes n8n
// activate the SAME trigger's webhooks again, but on a temporary
// /webhook-test/... URL, calling checkExists()/create() for it. Before this
// fix, create() happily re-registered Guardian for that temporary URL —
// since the backend's registerBoundWebhook (backend/src/routes/webhooks.ts)
// updates the existing (workflowId, nodeId) binding's url/secret IN PLACE,
// this silently overwrote the real published URL. ~2 minutes later, when
// the test listener tears down, delete() removed the registration entirely.
// The workflow still showed "Published" in n8n, but Guardian had no URL —
// or a dead test URL — until the user deactivated and reactivated it.
//
// Fix: checkExists/create/delete detect test mode (getActivationMode() ===
// 'manual', OR the webhook URL contains '/webhook-test/') and, in that case,
// make NO Guardian API call and leave staticData.webhookId/webhookSecret/
// webhookUrl completely untouched. checkExists() reports "already exists"
// (true) in test mode so n8n never calls create() for it at all.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { GuardianApprovalTrigger } = require('../dist/nodes/GuardianApprovalTrigger/GuardianApprovalTrigger.node.js');

const trigger = new GuardianApprovalTrigger();
const BASE = 'https://api.guardian.test';
const WF_ID = 'wf-1';
const NODE_ID = 'node-1';
const PROD_URL = `https://n8n.example.com/webhook/guardian/approval-resolved/${WF_ID}/${NODE_ID}`;
const TEST_URL = `https://n8n.example.com/webhook-test/guardian/approval-resolved/${WF_ID}/${NODE_ID}`;

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

// ── fetch stub: records every call; the whole point of most assertions
//    below is that NO call is ever made in test mode ──────────────────
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
	const u = String(url);
	const method = opts.method ?? 'GET';
	calls.push({ method, url: u, body: opts.body ? JSON.parse(opts.body) : undefined });
	if (method === 'GET' && u.endsWith('/v1/admin/webhooks')) {
		return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ webhooks: [] }) };
	}
	if (method === 'POST' && u.endsWith('/v1/admin/webhooks')) {
		const body = calls[calls.length - 1].body;
		return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ webhook: { id: 'wh-new', url: body.url, events: body.events, enabled: true } }) };
	}
	if (method === 'DELETE') {
		return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
	}
	return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
};
function reset() {
	calls = [];
}

const node = {
	id: NODE_ID,
	name: 'Guardian Approval Trigger',
	type: 'n8n-nodes-guardian.guardianApprovalTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function makeCtx({ staticData = {}, params = {}, activationMode = 'activate', webhookUrl = PROD_URL, logs = [] } = {}) {
	return {
		getCredentials: async () => ({ baseUrl: BASE, apiKey: 'gk_test', signingSecret: 'gs_test' }),
		getNode: () => node,
		getWorkflow: () => ({ id: WF_ID }),
		getNodeWebhookUrl: () => webhookUrl,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getActivationMode: () => activationMode,
		logger: {
			error(msg) { logs.push({ level: 'error', msg }); },
			warn(msg) { logs.push({ level: 'warn', msg }); },
			info(msg) { logs.push({ level: 'info', msg }); },
		},
	};
}

const { checkExists, create, delete: deleteHook } = trigger.webhookMethods.default;

console.log('\n🧪 Approval Trigger — test runs never touch the published registration\n');

// ── 1. getActivationMode() === 'manual' → checkExists reports "exists"
//    (so create() is never reached by n8n) and makes NO Guardian call ────
reset();
{
	const logs = [];
	const staticData = { webhookId: 'wh-prod', webhookSecret: 's-prod', webhookUrl: PROD_URL };
	const exists = await checkExists.call(makeCtx({ staticData, activationMode: 'manual', webhookUrl: PROD_URL, logs }));
	assertEqual(exists, true, 'test mode (activationMode=manual): checkExists() returns true so create() is skipped');
	assertEqual(calls.length, 0, 'test mode: checkExists() makes no Guardian API call');
	assertTrue(logs.some((l) => l.level === 'info' && l.msg.includes('Approvals only arrive once this workflow is published')), 'test mode: checkExists() logs a clear message');
	assertTrue(staticData.webhookId === 'wh-prod' && staticData.webhookSecret === 's-prod' && staticData.webhookUrl === PROD_URL, 'test mode: checkExists() leaves the published static data untouched');
}

// ── 2. getActivationMode() === 'manual' → create() makes no Guardian
//    call and does not touch static data, even if called directly ────────
reset();
{
	const logs = [];
	const staticData = { webhookId: 'wh-prod', webhookSecret: 's-prod', webhookUrl: PROD_URL };
	const ok = await create.call(makeCtx({ staticData, activationMode: 'manual', webhookUrl: TEST_URL, logs }));
	assertEqual(ok, true, 'test mode: create() returns true without doing anything');
	assertEqual(calls.length, 0, 'test mode: create() makes no Guardian API call (no GET list, no POST, no DELETE)');
	assertTrue(logs.some((l) => l.level === 'info'), 'test mode: create() logs a clear message');
	assertTrue(
		staticData.webhookId === 'wh-prod' && staticData.webhookSecret === 's-prod' && staticData.webhookUrl === PROD_URL,
		'test mode: create() leaves the published webhookId/secret/url completely unchanged (does not overwrite with the test URL)',
	);
}

// ── 3. getActivationMode() === 'manual' → delete() makes no Guardian
//    call and does not clear static data ──────────────────────────────────
reset();
{
	const logs = [];
	const staticData = { webhookId: 'wh-prod', webhookSecret: 's-prod', webhookUrl: PROD_URL };
	const ok = await deleteHook.call(makeCtx({ staticData, activationMode: 'manual', webhookUrl: TEST_URL, logs }));
	assertEqual(ok, true, 'test mode: delete() returns true without doing anything');
	assertEqual(calls.length, 0, 'test mode: delete() makes no Guardian API call');
	assertTrue(logs.some((l) => l.level === 'info'), 'test mode: delete() logs a clear message');
	assertTrue(
		staticData.webhookId === 'wh-prod' && staticData.webhookSecret === 's-prod' && staticData.webhookUrl === PROD_URL,
		'test mode: delete() does NOT clear the published registration — it survives the test listener tearing down',
	);
}

// ── 4. URL alone (/webhook-test/...) is also sufficient, even if
//    getActivationMode() were something else — belt-and-braces check ─────
reset();
{
	const logs = [];
	const staticData = { webhookId: 'wh-prod', webhookSecret: 's-prod', webhookUrl: PROD_URL };
	const ok = await create.call(makeCtx({ staticData, activationMode: 'activate', webhookUrl: TEST_URL, logs }));
	assertEqual(ok, true, 'URL-only signal (/webhook-test/ present, activationMode NOT manual): create() still treats it as test mode');
	assertEqual(calls.length, 0, 'URL-only signal: create() makes no Guardian API call');
}

// ── 5. Production behaviour is completely unchanged: activationMode
//    'activate' + a real production URL → create()/delete() work exactly
//    as before (and DO call Guardian) ─────────────────────────────────────
reset();
{
	const staticData = {};
	const ok = await create.call(makeCtx({ staticData, activationMode: 'activate', webhookUrl: PROD_URL }));
	assertEqual(ok, true, 'production: create() still succeeds');
	assertTrue(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/admin/webhooks')), 'production: create() still calls Guardian (POST /v1/admin/webhooks)');
	assertTrue(
		staticData.webhookId === 'wh-new' && staticData.webhookUrl === PROD_URL,
		'production: create() still stores the new registration in static data',
	);
}
reset();
{
	const staticData = { webhookId: 'wh-live', webhookSecret: 's', webhookUrl: PROD_URL };
	const ok = await deleteHook.call(makeCtx({ staticData, activationMode: 'activate', webhookUrl: PROD_URL }));
	assertEqual(ok, true, 'production: delete() still succeeds');
	assertTrue(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1/admin/webhooks/wh-live')), 'production: delete() still calls Guardian (DELETE)');
	assertTrue(staticData.webhookId === undefined, 'production: delete() still clears static data');
}

console.log(`\n${passed} assertions passed.`);
