import { StructuredTool } from '@langchain/core/tools';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
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

// Raw JSON schema to avoid Zod -> JSON Schema conversion bugs in n8n
const toolInputSchema = {
	type: 'object' as const,
	properties: {
		actionType: {
			type: 'string' as const,
			description: 'The type of action to check. Examples: "payment.send", "data.export", "user.delete"',
		},
		payload: {
			type: 'object' as const,
			description: 'Complete action payload required to execute after approval. Include every exact action field.',
			additionalProperties: true,
		},
		amount: {
			type: 'number' as const,
			description: 'Payment amount if applicable, e.g. 500',
		},
		recipient: {
			type: 'string' as const,
			description: 'Recipient email or identifier, e.g. "vendor@example.com"',
		},
		recipientDomain: {
			type: 'string' as const,
			description: 'Normalized recipient domain including @, e.g. "@example.com"',
		},
		subject: {
			type: 'string' as const,
			description: 'Email subject if the action sends an email',
		},
		body: {
			type: 'string' as const,
			description: 'Complete email body if the action sends an email',
		},
		reason: {
			type: 'string' as const,
			description: 'Reason for the action',
		},
	},
	required: ['actionType'],
};

async function callGuardianApi(
	input: GuardianInput,
	credentials: GuardianApiCredentials,
	projectSlug: string,
	requester: string,
	idempotencyKey: string,
	testMode: boolean,
	mode: 'evaluate' | 'evaluateAndExecute',
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

class GuardianSafetyTool extends StructuredTool<typeof toolInputSchema> {
	name = 'guardian_safety_check';
	description = '';
	schema = toolInputSchema;

	constructor(
		private readonly credentials: GuardianApiCredentials,
		private readonly projectSlug: string,
		private readonly requester: string,
		private readonly idempotencyKey: string,
		private readonly testMode: boolean,
		private readonly mode: 'evaluate' | 'evaluateAndExecute',
		description: string,
		private readonly ctx: ISupplyDataFunctions,
		private readonly itemIndex: number,
	) {
		super();
		this.description = description;
	}

	protected async _call(input: GuardianInput): Promise<string> {
		const result = await callGuardianApi(
			input,
			this.credentials,
			this.projectSlug,
			this.requester,
			this.idempotencyKey || randomString(16),
			this.testMode,
			this.mode,
		);
		try {
			let parsed: IDataObject = {};
			try {
				parsed = JSON.parse(result) as IDataObject;
			} catch {
				parsed = { response: result };
			}
			await this.ctx.addOutputData(NodeConnectionTypes.AiTool, this.itemIndex, [[{ json: parsed }]]);
		} catch (error) {
			// Don't fail the tool if UI logging fails
			console.error('Guardian tool: addOutputData failed', error);
		}
		return result;
	}
}

async function createGuardianTool(
	ctx: ISupplyDataFunctions,
	itemIndex: number,
): Promise<GuardianSafetyTool> {
	const credentials = await ctx.getCredentials('guardianApi') as unknown as GuardianApiCredentials;

	const projectSlug = ctx.getNodeParameter('projectSlug', itemIndex, '') as string;
	const requester = ctx.getNodeParameter('requester', itemIndex, 'n8n-ai-agent') as string;
	const idempotencyKey = ctx.getNodeParameter('idempotencyKey', itemIndex, '') as string;
	const testMode = ctx.getNodeParameter('testMode', itemIndex, false) as boolean;
	const mode = ctx.getNodeParameter('mode', itemIndex, 'evaluate') as 'evaluate' | 'evaluateAndExecute';
	const toolDescription = ctx.getNodeParameter('toolDescription', itemIndex,
		'REQUIRED safety gate: Check if an action is allowed by Guardian policy before executing it. ' +
		'You MUST call this tool before confirming any payment, transfer, data export, user deletion, or sensitive action. ' +
		'This is the only path that can authorize an action. Pass actionType and the complete exact action payload required for later execution. ' +
		'For email.send include recipient, subject, and body. Guardian derives recipientDomain from recipient for domain policies. Returns JSON containing decision, intentRunId, actionType, and payload. ' +
		'Copy the returned intentRunId, decision, and actionType exactly into your final structured JSON response.'
	) as string;

	return new GuardianSafetyTool(credentials, projectSlug, requester, idempotencyKey, testMode, mode, toolDescription, ctx, itemIndex);
}

export class GuardianTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Agent Check',
		name: 'guardianTool',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
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
				description: 'Whether to run this intent in test mode (does not consume quota).',
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const tool = await createGuardianTool(this, itemIndex);
		return { response: tool };
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const input = this.getInputData();
		const response: INodeExecutionData[] = [];

		for (let i = 0; i < input.length; i++) {
			const credentials = await this.getCredentials('guardianApi') as unknown as GuardianApiCredentials;
			const projectSlug = this.getNodeParameter('projectSlug', i, '') as string;
			const requester = this.getNodeParameter('requester', i, 'n8n-ai-agent') as string;

			const idempotencyKey = this.getNodeParameter('idempotencyKey', i, '') as string;
			const testMode = this.getNodeParameter('testMode', i, false) as boolean;
			const mode = this.getNodeParameter('mode', i, 'evaluate') as 'evaluate' | 'evaluateAndExecute';

			const result = await callGuardianApi(input[i].json as unknown as GuardianInput, credentials, projectSlug, requester, idempotencyKey, testMode, mode);
			response.push({
				json: JSON.parse(result),
				pairedItem: { item: i },
			});
		}

		return [response];
	}
}
