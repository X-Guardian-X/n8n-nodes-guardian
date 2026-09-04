import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { buildGuardianRequestHeaders } from '../nodes/shared/guardianApiRequest';

/**
 * Default Guardian cloud backend URL shown in the credential's Base URL field.
 * Self-hosted users can still override the field. If the hosted backend domain
 * ever moves, update THIS constant (plus the dashboard display, which reads
 * NEXT_PUBLIC_API_URL on the frontend).
 */
export const DEFAULT_GUARDIAN_BASE_URL = 'https://api.guardian-safety-gate.com';

export class GuardianApi implements ICredentialType {
	name = 'guardianApi';
	displayName = 'Guardian API';
	icon = 'file:guardian.svg' as const;
	documentationUrl = 'https://guardiansafetygate.com/docs';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your Guardian API key. Find it under Settings → API Keys.',
		},
		{
			displayName: 'API Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: false,
			description: 'If Require Signing was enabled for this API key, paste the one-time gs_ signing secret here. Leave blank for unsigned keys.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_GUARDIAN_BASE_URL,
			required: true,
			description: 'The base URL of your Guardian instance. Guardian Cloud users: keep the default. Self-hosted: your own backend URL. Shown on the Guardian dashboard under Settings → API Keys.',
		},
	];

	// Applies x-guardian-key (+ HMAC signing headers when a signing secret is
	// set) to credential test requests. GET requests sign an empty body, which
	// matches the backend's verification for bodyless requests.
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const headers = buildGuardianRequestHeaders(
			{
				baseUrl: credentials.baseUrl as string,
				apiKey: credentials.apiKey as string,
				signingSecret: credentials.signingSecret as string | undefined,
			},
			'',
		);
		requestOptions.headers = { ...requestOptions.headers, ...headers };
		return requestOptions;
	}

	// Cheap authenticated read: validates Base URL + API key (+ signing) at
	// credential setup time instead of failing three nodes deep at runtime.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/killswitch',
			method: 'GET',
		},
	};
}
