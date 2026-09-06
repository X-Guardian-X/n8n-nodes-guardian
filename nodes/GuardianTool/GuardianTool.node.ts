import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, randomString } from 'n8n-workflow';
import { guardianApiRequest, type GuardianApiCredentials } from '../shared/guardianApiRequest';

interface GuardianInput {
	actionType: string;
	payload?: Record<string, unknown>;
	amount?: number;
	recipient?: string;
	recipientDomain?: string;
	subject?: string;
	body?: string;
	reason?: string;
}

async function callGuardianApi(
	input: GuardianInput,
	credentials: GuardianApiCredentials,
	projectSlug: string,
	requester: string,
	idempotencyKey: string,
	testMode: boolean,
	mode: 'evaluate' | 'evaluateAndExecute',
	node: INode,
): Promise<string> {
	const payload: Record<string, unknown> = input.payload ? { ...input.payload } : {};
	if (input.amount !== undefined) payload.amount = input.amount;
	const recipient = input.recipient || (typeof payload.recipient === 'string' ? payload.recipient : '');
	if (recipient) {
		payload.recipient = recipient;
		const recipientDomain = recipient.split('@').pop()?.trim().toLowerCase();
		if (recipientDomain) payload.recipientDomain = `@${recipientDomain}`;
	} else if (input.recipientDomain) {
		payload.recipientDomain = input.recipientDomain.startsWith('@')
			? input.recipientDomain.toLowerCase()
			: `@${input.recipientDomain.toLowerCase()}`;
	}
	if (input.subject) payload.subject = input.subject;
	if (input.body) payload.body = input.body;
	if (input.reason) payload.reason = input.reason;

	const body: Record<string, unknown> = {
		actionType: input.actionType,
		payload,
		requester,
	};
	if (projectSlug) body.projectSlug = projectSlug;

	const headers: Record<string, string> = {};
	if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
	if (testMode) headers['x-guardian-testmode'] = 'true';

	try {
		const result = await guardianApiRequest<{
			decision: string;
			intentRunId: string;
			decisionReason?: string;
			wouldHaveDecision?: string;
			wouldHaveDecisionNotice?: string;
			policyHits?: unknown[];
		}>(credentials, {
			method: 'POST',
			path: '/v1/intents/check',
			headers,
			body,
			node,
		});
		const decision = (result.decision || '').toUpperCase();

		if (decision === 'OBSERVED') {
			return JSON.stringify({
				decision: 'OBSERVED',
				canProceed: true,
				executed: false,
				intentRunId: result.intentRunId,
				actionType: input.actionType,
				payload,
				message: 'OBSERVED — NOT ENFORCED. Action may proceed; Guardian did not execute this intent.',
				advisoryDecision: result.wouldHaveDecision || null,
				advisoryNotice:
					result.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.',
			});
		}

		if (decision === 'ALLOW') {
			if (mode === 'evaluateAndExecute') {
				await guardianApiRequest(credentials, {
					method: 'POST',
					path: `/v1/intents/${encodeURIComponent(result.intentRunId)}/execute`,
					body: { payload },
					node,
				});
				return JSON.stringify({
					decision: 'ALLOW',
					canProceed: true,
					message: 'Action is allowed and has been executed.',
					intentRunId: result.intentRunId,
					actionType: input.actionType,
					payload,
					executed: true,
				});
			}
			return JSON.stringify({
				decision: 'ALLOW',
				canProceed: true,
				message: 'Action is allowed but NOT executed. Pass intentRunId to your execution step.',
				intentRunId: result.intentRunId,
				actionType: input.actionType,
				payload,
				executed: false,
			});
		} else if (decision === 'DENY') {
			return JSON.stringify({
				decision: 'DENY',
				canProceed: false,
				message: `Action DENIED. Reason: ${result.decisionReason || 'Policy violation'}`,
				intentRunId: result.intentRunId,
				actionType: input.actionType,
				payload,
			});
		} else {
			return JSON.stringify({
				decision: 'REQUIRE_APPROVAL',
				canProceed: false,
				message: 'This action requires human approval.',
				intentRunId: result.intentRunId,
				actionType: input.actionType,
				payload,
			});
		}
	} catch (error) {
		return JSON.stringify({
			decision: 'ERROR',
			canProceed: false,
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
}

export class GuardianTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Agent Check',
		name: 'guardianTool',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["mode"]}}',
		description: 'AI Agent tool to check actions against Guardian policies',
		defaults: {
			name: 'Guardian Agent Check',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
				Tools: ['Other Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://guardiansafetygate.com/docs',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [
			{
				name: 'guardianApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Connect this tool to an AI Agent node',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Action Type',
				name: 'actionType',
				type: 'string',
				default: `={{ $fromAI('actionType', 'The type of action to check. Examples: "payment.send", "data.export", "user.delete"', 'string') }}`,
				description: 'The type of action to check. Examples: "payment.send", "data.export", "user.delete".',
			},
			{
				displayName: 'Payload',
				name: 'payload',
				type: 'json',
				default: `={{ $fromAI('payload', 'Complete action payload required to execute after approval. Include every exact action field.', 'json') }}`,
				description: 'Complete action payload required to execute after approval. Include every exact action field.',
			},
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'number',
				default: 0,
				description: 'Payment amount if applicable, e.g. 500',
			},
			{
				displayName: 'Recipient',
				name: 'recipient',
				type: 'string',
				default: `={{ $fromAI('recipient', 'Recipient email or identifier, e.g. "vendor@example.com"', 'string') }}`,
				description: 'Recipient email or identifier, e.g. "vendor@example.com"',
			},
			{
				displayName: 'Recipient Domain',
				name: 'recipientDomain',
				type: 'string',
				default: `={{ $fromAI('recipientDomain', 'Normalized recipient domain including @, e.g. "@example.com"', 'string') }}`,
				description: 'Normalized recipient domain including @, e.g. "@example.com"',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: `={{ $fromAI('subject', 'Email subject if the action sends an email', 'string') }}`,
				description: 'Email subject if the action sends an email',
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				default: `={{ $fromAI('body', 'Complete email body if the action sends an email', 'string') }}`,
				description: 'Complete email body if the action sends an email',
			},
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'string',
				default: `={{ $fromAI('reason', 'Reason for the action', 'string') }}`,
				description: 'Reason for the action',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				default: 'REQUIRED safety gate: Check if an action is allowed by Guardian policy before executing it. You MUST call this tool before confirming any payment, transfer, data export, user deletion, email, or sensitive action. Pass actionType and the complete exact action payload required for later execution. For email.send include recipient, subject, and body. Returns JSON containing decision, intentRunId, actionType, and payload. Copy the returned intentRunId, decision, and actionType exactly into your final structured JSON response.',
				description: 'Description shown to the AI agent',
				typeOptions: {
					rows: 5,
				},
			},
			{
				displayName: 'Requester Name',
				name: 'requester',
				type: 'string',
				default: 'n8n-ai-agent',
				description: 'Identifier for this AI agent in Guardian audit logs',
			},
			{
				displayName: 'Project Slug',
				name: 'projectSlug',
				type: 'string',
				default: '',
				placeholder: 'e.g. finance, marketing',
				description: 'Optional. Scope to a specific Guardian project.',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				default: 'evaluate',
				description: 'Evaluate Only is recommended with Guardian Enforce. The legacy option marks an allowed intent executed inside Guardian but does not perform the external action.',
				options: [
					{
						name: 'Evaluate Only (Recommended with Guardian Enforce)',
						value: 'evaluate',
					},
					{
						name: 'Evaluate and Mark Executed (Legacy)',
						value: 'evaluateAndExecute',
					},
				],
			},
			{
				displayName: 'Test Mode',
				name: 'testMode',
				type: 'boolean',
				default: false,
				description: 'Whether to run this intent in test mode (does not consume quota)',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{ $json.sessionId }}',
				description: 'Optional. Prevents duplicate processing on retries. If empty, a random key is generated per call.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const response: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const credentials = await this.getCredentials('guardianApi') as unknown as GuardianApiCredentials;
			const projectSlug = this.getNodeParameter('projectSlug', i, '') as string;
			const requester = this.getNodeParameter('requester', i, 'n8n-ai-agent') as string;

			const idempotencyKeyParam = this.getNodeParameter('idempotencyKey', i, '') as string;
			const idempotencyKey = idempotencyKeyParam || randomString(16);
			const testMode = this.getNodeParameter('testMode', i, false) as boolean;
			const mode = this.getNodeParameter('mode', i, 'evaluate') as 'evaluate' | 'evaluateAndExecute';

			const actionType = this.getNodeParameter('actionType', i, '') as string;
			const payloadRaw = this.getNodeParameter('payload', i, {}) as unknown;
			let payload: Record<string, unknown> = {};
			if (typeof payloadRaw === 'string' && payloadRaw.trim()) {
				try {
					payload = JSON.parse(payloadRaw);
				} catch {
					payload = {};
				}
			} else if (payloadRaw && typeof payloadRaw === 'object') {
				payload = payloadRaw as Record<string, unknown>;
			}
			const amountRaw = this.getNodeParameter('amount', i, undefined) as number | string | undefined;
			const amount = amountRaw === undefined || amountRaw === '' ? undefined : Number(amountRaw);
			const recipient = this.getNodeParameter('recipient', i, '') as string;
			const recipientDomain = this.getNodeParameter('recipientDomain', i, '') as string;
			const subject = this.getNodeParameter('subject', i, '') as string;
			const body = this.getNodeParameter('body', i, '') as string;
			const reason = this.getNodeParameter('reason', i, '') as string;

			const guardianInput: GuardianInput = { actionType, payload, amount, recipient, recipientDomain, subject, body, reason };

			const result = await callGuardianApi(guardianInput, credentials, projectSlug, requester, idempotencyKey, testMode, mode, this.getNode());
			response.push({
				json: JSON.parse(result),
				pairedItem: { item: i },
			});
		}

		return [response];
	}
}
