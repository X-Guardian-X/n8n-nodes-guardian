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

interface GuardianGateInput {
	actionType: string;
	payload?: Record<string, unknown>;
	amount?: number;
	recipient?: string;
	recipientDomain?: string;
	subject?: string;
	body?: string;
	reason?: string;
}

const toolInputSchema = {
	type: 'object' as const,
	properties: {
		actionType: {
			type: 'string' as const,
			description: 'The type of action to check. Examples: "email.send", "payment.send", "data.export", "user.delete"',
		},
		payload: {
			type: 'object' as const,
			description: 'Complete action payload. Include every exact action field (recipient, subject, body, amount, etc.). This same payload is used for integrity verification at execution time.',
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

interface GateResult {
	decision: string;
	executed: boolean;
	duplicateBlocked?: boolean;
	intentRunId?: string;
	actionType: string;
	payload: Record<string, unknown>;
	executedAt?: string;
	decisionReason?: string;
	advisoryDecision?: string | null;
	advisoryNotice?: string;
	error?: string;
	message: string;
}

async function guardianGateCheck(
	input: GuardianGateInput,
	credentials: GuardianApiCredentials,
	projectSlug: string,
	requester: string,
	idempotencyKey: string,
	testMode: boolean,
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
		// Step 1: Evaluate policy
		const evalResult = await guardianApiRequest<{
			decision: string;
			intentRunId: string;
			decisionReason?: string;
			wouldHaveDecision?: string;
			wouldHaveDecisionNotice?: string;
			status?: string;
			actionType?: string;
		}>(credentials, {
			method: 'POST',
			path: '/v1/intents/check',
			headers,
			body,
		});

		const decision = evalResult.decision?.toUpperCase() || 'ERROR';
		const intentRunId = evalResult.intentRunId;

		// Step 2: If ALLOW, atomically claim execution (verify + claim in one call)
		if (decision === 'ALLOW') {
			try {
				const execResult = await guardianApiRequest<{
					executed?: boolean;
					idempotent?: boolean;
					executedAt?: string;
					decision?: string;
				}>(credentials, {
					method: 'POST',
					path: `/v1/intents/${encodeURIComponent(intentRunId)}/execute`,
					headers,
					body: { payload },
				});

				if (execResult.idempotent === true) {
					const result: GateResult = {
						decision: 'ALLOW',
						executed: false,
						duplicateBlocked: true,
						intentRunId,
						actionType: input.actionType,
						payload,
						message: 'This action was already executed. Duplicate blocked by Guardian.',
					};
					return JSON.stringify(result);
				}

				const result: GateResult = {
					decision: 'ALLOW',
					executed: execResult.executed === true,
					intentRunId,
					actionType: input.actionType,
					payload,
					executedAt: execResult.executedAt,
					message: 'Action allowed and execution claimed. Proceed with the action.',
				};
				return JSON.stringify(result);
			} catch (execError) {
				const result: GateResult = {
					decision: 'ERROR',
					executed: false,
					intentRunId,
					actionType: input.actionType,
					payload,
					error: `Execution claim failed: ${execError instanceof Error ? execError.message : 'Unknown error'}`,
					message: 'Guardian allowed the action but execution claim failed. Do NOT proceed.',
				};
				return JSON.stringify(result);
			}
		}

		if (decision === 'DENY') {
			const result: GateResult = {
				decision: 'DENY',
				executed: false,
				intentRunId,
				actionType: input.actionType,
				payload,
				decisionReason: evalResult.decisionReason,
				message: `Action DENIED. Reason: ${evalResult.decisionReason || 'Policy violation'}`,
			};
			return JSON.stringify(result);
		}

		if (decision === 'OBSERVED') {
			const result: GateResult = {
				decision: 'OBSERVED',
				executed: false,
				intentRunId,
				actionType: input.actionType,
				payload,
				advisoryDecision: evalResult.wouldHaveDecision || null,
				advisoryNotice:
					evalResult.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.',
				message: 'OBSERVED — NOT ENFORCED. Action may proceed; Guardian did not execute this intent.',
			};
			return JSON.stringify(result);
		}

		if (decision === 'REQUIRE_APPROVAL') {
			const result: GateResult = {
				decision: 'REQUIRE_APPROVAL',
				executed: false,
				intentRunId,
				actionType: input.actionType,
				payload,
				message: 'This action requires human approval. It has been submitted for approval.',
			};
			return JSON.stringify(result);
		}

		const result: GateResult = {
			decision: 'ERROR',
			executed: false,
			intentRunId,
			actionType: input.actionType,
			payload,
			error: `Unexpected decision from Guardian: ${decision}`,
			message: 'Guardian returned an unexpected decision.',
		};
		return JSON.stringify(result);
	} catch (error) {
		const result: GateResult = {
			decision: 'ERROR',
			executed: false,
			error: error instanceof Error ? error.message : 'Unknown error',
			actionType: input.actionType,
			payload,
			message: 'Guardian safety check failed. Do NOT proceed.',
		};
		return JSON.stringify(result);
	}
}

class GuardianGateTool extends StructuredTool<typeof toolInputSchema> {
	name = 'guardian_gate';
	description = '';
	schema = toolInputSchema;

	constructor(
		private readonly credentials: GuardianApiCredentials,
		private readonly projectSlug: string,
		private readonly requester: string,
		private readonly idempotencyKey: string,
		private readonly testMode: boolean,
		description: string,
		private readonly ctx: ISupplyDataFunctions,
		private readonly itemIndex: number,
	) {
		super();
		this.description = description;
	}

	protected async _call(input: GuardianGateInput): Promise<string> {
		const result = await guardianGateCheck(
			input,
			this.credentials,
			this.projectSlug,
			this.requester,
			this.idempotencyKey || randomString(16),
			this.testMode,
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
			console.error('Guardian Agent Check & Claim: addOutputData failed', error);
		}
		return result;
	}
}

async function createGuardianGateTool(
	ctx: ISupplyDataFunctions,
	itemIndex: number,
): Promise<GuardianGateTool> {
	const credentials = await ctx.getCredentials('guardianApi') as unknown as GuardianApiCredentials;

	const projectSlug = ctx.getNodeParameter('projectSlug', itemIndex, '') as string;
	const requester = ctx.getNodeParameter('requester', itemIndex, 'n8n-ai-agent') as string;
	const idempotencyKey = ctx.getNodeParameter('idempotencyKey', itemIndex, '') as string;
	const testMode = ctx.getNodeParameter('testMode', itemIndex, false) as boolean;
	const toolDescription = ctx.getNodeParameter('toolDescription', itemIndex,
		'REQUIRED safety gate: Call this tool BEFORE performing any action. ' +
		'Pass actionType and the complete payload (recipient, subject, body, amount, etc.). ' +
		'The tool evaluates Guardian policy AND atomically claims execution if allowed — no separate verify step needed. ' +
		'Returns JSON with: decision (ALLOW/DENY/REQUIRE_APPROVAL/ERROR), executed (true/false), intentRunId, actionType, payload, message. ' +
		'If decision is ALLOW and executed is true, the action is authorized and claimed — proceed with it. ' +
		'If DENY, do not proceed. If REQUIRE_APPROVAL, tell the user it is queued for approval. ' +
		'In your final response, output ONLY a JSON object with: intentRunId, decision, actionType, recipient, subject, body, message.'
	) as string;

	return new GuardianGateTool(credentials, projectSlug, requester, idempotencyKey, testMode, toolDescription, ctx, itemIndex);
}

export class GuardianGate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Agent Check & Claim',
		name: 'guardianGate',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
		description: 'All-in-one Guardian safety gate: evaluates policy, verifies intent, and atomically claims execution in a single call',
		defaults: {
			name: 'Guardian Agent Check & Claim',
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
				displayName: 'Connect this tool to an AI Agent node. It handles policy evaluation, intent verification, and execution claiming in one call — no separate Guardian Enforce or Code nodes needed.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				default: 'REQUIRED safety gate: Call this tool BEFORE performing any action. Pass actionType and the complete payload (recipient, subject, body, amount, etc.). The tool evaluates Guardian policy AND atomically claims execution if allowed — no separate verify step needed. Returns JSON with: decision (ALLOW/DENY/REQUIRE_APPROVAL/ERROR), executed (true/false), intentRunId, actionType, payload, message. If decision is ALLOW and executed is true, the action is authorized and claimed — proceed with it. If DENY, do not proceed. If REQUIRE_APPROVAL, tell the user it is queued for approval. In your final response, output ONLY a JSON object with: intentRunId, decision, actionType, recipient, subject, body, message.',
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
		const tool = await createGuardianGateTool(this, itemIndex);
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

			const result = await guardianGateCheck(
				input[i].json as unknown as GuardianGateInput,
				credentials,
				projectSlug,
				requester,
				idempotencyKey,
				testMode,
			);
			response.push({
				json: JSON.parse(result),
				pairedItem: { item: i },
			});
		}

		return [response];
	}
}
