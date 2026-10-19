import { createHmac, randomBytes } from 'crypto';
import type { IDataObject, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export interface GuardianApiCredentials {
	baseUrl: string;
	apiKey: string;
	signingSecret?: string;
}

export interface GuardianApiRequestOptions {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
	node: INode;
}

// Fixed, non-configurable: Guardian not answering within this window means
// nothing was decided, so the caller must treat it exactly like any other
// unreachable-API error — never assume a decision. No retries: a retry is a
// product decision (idempotency/backoff semantics) left to a future change,
// not something to add silently here.
const GUARDIAN_API_TIMEOUT_MS = 30_000;

// Attached to the thrown NodeApiError so a call site that needs to react to
// a *specific* Guardian response (e.g. the Enforce resource's kill-switch
// carve-out) can inspect the real status/body, instead of parsing the
// flattened message string. Optional — every existing catch site that only
// reads `error.message` keeps working unchanged.
export interface GuardianApiErrorDetails {
	guardianStatus?: number;
	guardianResponseBody?: unknown;
}

export function buildGuardianRequestHeaders(
	credentials: GuardianApiCredentials,
	rawBody: string,
	additionalHeaders: Record<string, string> = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'x-guardian-key': credentials.apiKey,
		'x-guardian-capabilities': 'observed-decision',
		...additionalHeaders,
	};
	const signingSecret = credentials.signingSecret?.trim();
	if (!signingSecret) return headers;

	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = randomBytes(16).toString('hex');
	const signature = createHmac('sha256', signingSecret)
		.update(`${timestamp}.${nonce}.${rawBody}`)
		.digest('hex');

	headers['x-guardian-timestamp'] = timestamp;
	headers['x-guardian-nonce'] = nonce;
	headers['x-guardian-signature'] = signature;
	return headers;
}

export async function guardianApiRequest<T = IDataObject>(
	credentials: GuardianApiCredentials,
	options: GuardianApiRequestOptions,
): Promise<T> {
	const baseUrl = credentials.baseUrl.replace(/\/$/, '');
	const rawBody = options.body === undefined
		? ''
		: typeof options.body === 'string'
			? options.body
			: JSON.stringify(options.body);
	const additionalHeaders = { ...options.headers };
	if (options.body !== undefined) additionalHeaders['Content-Type'] = 'application/json';
	const headers = buildGuardianRequestHeaders(credentials, rawBody, additionalHeaders);

	let response: Response;
	try {
		response = await fetch(`${baseUrl}${options.path}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : rawBody,
			// Fixed 30s timeout, no retries — see GUARDIAN_API_TIMEOUT_MS above.
			signal: AbortSignal.timeout(GUARDIAN_API_TIMEOUT_MS),
		});
	} catch (networkError) {
		// AbortSignal.timeout firing surfaces as a DOMException/Error named
		// 'TimeoutError' (WHATWG spec; implemented by undici/Node's fetch).
		// Handled as its own case — same throw path as every other network
		// error below, just a message that says nothing was decided rather
		// than implying a reachability/Base-URL problem.
		if (networkError instanceof Error && networkError.name === 'TimeoutError') {
			const message = 'Guardian did not answer within 30 seconds. Nothing was decided, so the action must not run.';
			throw new NodeApiError(options.node, { message } as JsonObject);
		}
		// DNS failure, connection refused, TLS error — the host is wrong or down.
		const message = `Could not reach the Guardian API — check the Base URL on your credential (tried "${baseUrl}${options.path}": ${networkError instanceof Error ? networkError.message : String(networkError)})`;
		throw new NodeApiError(options.node, { message } as JsonObject);
	}
	const responseText = await response.text();
	let responseData: unknown = {};
	let parsedJson = false;
	if (responseText) {
		try {
			responseData = JSON.parse(responseText);
			parsedJson = true;
		} catch {
			responseData = { message: responseText };
		}
	}

	if (!response.ok) {
		// Guardian always returns JSON errors. An HTML error page, a proxy/host
		// error page, or any non-JSON body means the request hit something that
		// isn't the Guardian API — almost always a wrong Base URL.
		if (!parsedJson) {
			const message = `Could not reach the Guardian API — check the Base URL on your credential (received a non-JSON HTTP ${response.status} response from "${baseUrl}${options.path}")`;
			throw new NodeApiError(options.node, { message } as JsonObject);
		}
		const errorDataWithDetails = responseData as { error?: string; message?: string; details?: Array<{ field: string; message: string }> };
		// Always fall through to something non-empty, even when the body has
		// neither `.message` nor `.error` (e.g. `{}`) and statusText is blank
		// (common with HTTP/2, which has no reason phrases) — the raw body is
		// appended below regardless, so the message is never just a bare,
		// unexplained status code.
		const baseMessage = errorDataWithDetails.message || errorDataWithDetails.error || response.statusText || 'no error message in response body';
		const detailStr = errorDataWithDetails.details?.length
			? ' (' + errorDataWithDetails.details.map(d => `${d.field}: ${d.message}`).join('; ') + ')'
			: '';
		const message = `Guardian API request failed (${response.status}): ${baseMessage}${detailStr} [body: ${responseText || '{}'}]`;
		// `message` must ALSO be passed via the options (3rd) argument, not
		// just inside errorResponse: NodeApiError only skips its own generic
		// per-status-code message (e.g. "Authorization failed - please check
		// your credentials" for 401) when `options.message` is set. Setting
		// `httpCode` (needed below for guardianStatus/the Enforce kill-switch
		// check) without this would silently replace our status+body message
		// with that generic text.
		const apiError = new NodeApiError(
			options.node,
			{ message } as JsonObject,
			{ message, httpCode: String(response.status) },
		);
		const errorDetails: GuardianApiErrorDetails = { guardianStatus: response.status, guardianResponseBody: responseData };
		Object.assign(apiError, errorDetails);
		throw apiError;
	}

	return responseData as T;
}
