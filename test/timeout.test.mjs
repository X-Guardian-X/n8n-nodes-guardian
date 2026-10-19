// Unit test: guardianApiRequest's fixed 30s timeout (fix 1).
//
// Spins up a REAL local HTTP server that accepts the connection but never
// responds, so this exercises the actual fetch()+AbortSignal.timeout path —
// not a mocked fetch — and therefore takes ~30 real seconds to run. That is
// inherent to testing a genuine, fixed (non-configurable) timeout honestly;
// faking the clock would not prove the real fetch call is wired to abort.
//
// Run: node test/timeout.test.mjs

import { createServer } from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { guardianApiRequest } = require('../dist/nodes/shared/guardianApiRequest.js');

let passed = 0;
function assertTrue(condition, message) {
	if (!condition) throw new Error(`❌ ${message}`);
	passed++;
	console.log(`✅ ${message}`);
}

const node = { name: 'Guardian', type: 'n8n-nodes-guardian.guardian' };

async function main() {
	// Accepts the connection, never writes a response — simulates Guardian
	// being up at the TCP level but never answering (hung request, not a
	// connection-refused/DNS case, which guardianApiRequest already handles
	// separately via the generic network-error catch).
	let connectionCount = 0;
	const server = createServer(() => {
		connectionCount++;
		// Intentionally never calls res.end() / res.writeHead().
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;

	try {
		const startedAt = Date.now();
		let caught = null;
		try {
			await guardianApiRequest(
				{ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'gk_test' },
				{ method: 'GET', path: '/v1/intents/abc', node },
			);
		} catch (error) {
			caught = error;
		}
		const elapsedMs = Date.now() - startedAt;

		assertTrue(caught !== null, 'a hung request throws instead of resolving');
		assertTrue(
			caught.message === 'Guardian did not answer within 30 seconds. Nothing was decided, so the action must not run.',
			`exact timeout message (got: ${caught && caught.message})`,
		);
		// 30s nominal; generous window either side for CI/test-runner jitter —
		// the point is confirming it fired at ~30s, not immediately and not
		// hanging indefinitely.
		assertTrue(elapsedMs >= 28_000 && elapsedMs <= 35_000, `fired at ~30s, not before/after (elapsed: ${elapsedMs}ms)`);

		// No retries: exactly one connection should have been accepted by the
		// hung-response server (a retry would open a second one).
		assertTrue(connectionCount === 1, `no retries — exactly one connection attempt (got: ${connectionCount})`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	console.log(`\n${passed} assertions passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
