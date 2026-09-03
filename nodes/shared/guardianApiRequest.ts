import { createHmac, randomBytes } from 'crypto';
import type { IDataObject } from 'n8n-workflow';

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
		});
	} catch (networkError) {
		// DNS failure, connection refused, TLS error — the host is wrong or down.
		throw new Error(
			`Could not reach the Guardian API — check the Base URL on your credential (tried "${baseUrl}${options.path}": ${networkError instanceof Error ? networkError.message : String(networkError)})`,
		);
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
		const errorData = responseData as { error?: string; message?: string };
		// Guardian always returns JSON errors. An HTML error page, a proxy/host
		// error page, or any non-JSON body means the request hit something that
		// isn't the Guardian API — almost always a wrong Base URL.
		if (!parsedJson) {
			throw new Error(
				`Could not reach the Guardian API — check the Base URL on your credential (received a non-JSON HTTP ${response.status} response from "${baseUrl}${options.path}")`,
			);
		}
		const errorDataWithDetails = responseData as { error?: string; message?: string; details?: Array<{ field: string; message: string }> };
		const baseMessage = errorDataWithDetails.message || errorDataWithDetails.error || response.statusText;
		const detailStr = errorDataWithDetails.details?.length
			? ' (' + errorDataWithDetails.details.map(d => `${d.field}: ${d.message}`).join('; ') + ')'
			: '';
		throw new Error(`Guardian API request failed (${response.status}): ${baseMessage}${detailStr}`);
	}

	return responseData as T;
}
