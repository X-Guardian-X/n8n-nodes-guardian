import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { createHash } from 'crypto';
import { NodeConnectionTypes } from 'n8n-workflow';
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

function normalizeGatePayload(input: GuardianGateInput): Record<string, unknown> {
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
	return payload;
}

function buildExecutionScopedIdempotencyKey(
	executionId: string,
	actionType: string,
	payload: Record<string, unknown>,
): string {
	const part = (value: unknown): string => {
		if (value === undefined || value === null) return '';
		return typeof value === 'string' ? value.trim().toLowerCase() : String(value);
	};

	const basis = [
		part(actionType),
		part(payload.recipient),
		part(payload.subject),
		part(payload.amount),
	].join('|');

	const digest = createHash('sha256').update(basis).digest('hex').slice(0, 16);
	return `n8n-exec:${executionId}:${digest}`;
}

async function guardianGateCheck(
	input: GuardianGateInput,
	credentials: GuardianApiCredentials,
	projectSlug: string,
	requester: string,
	idempotencyKey: string,
	testMode: boolean,
	node: INode,
): Promise<string> {
	const payload = normalizeGatePayload(input);

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
			node,
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
					node,
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

export class GuardianGate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Agent Check & Claim',
		name: 'guardianGate',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
		subtitle: '',
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
				displayName: 'Action Type',
				name: 'actionType',
				type: 'string',
				default: `={{ $fromAI('actionType', 'The type of action to check. Examples: "email.send", "payment.send", "data.export", "user.delete"', 'string') }}`,
				description: 'The type of action to check. Examples: "email.send", "payment.send", "data.export", "user.delete".',
			},
			{
				displayName: 'Payload',
				name: 'payload',
				type: 'json',
				default: `={{ $fromAI('payload', 'Complete action payload. Include every exact action field (recipient, subject, body, amount, etc.). This same payload is used for integrity verification at execution time.', 'json') }}`,
				description: 'Complete action payload. Include every exact action field (recipient, subject, body, amount, etc.). This same payload is used for integrity verification at execution time.',
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
				description: 'Whether to run this intent in test mode (does not consume quota)',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{ $json.sessionId }}',
				description: 'Optional. Prevents duplicate intents. If empty, a deterministic key is derived from this workflow execution plus the action identity (actionType, recipient, subject, amount), so repeated tool calls for the same action within one execution collapse into a single intent.',
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
			const testMode = this.getNodeParameter('testMode', i, false) as boolean;

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

			const guardianGateInput: GuardianGateInput = { actionType, payload, amount, recipient, recipientDomain, subject, body, reason };

			// Deterministic execution-scoped idempotency: an AI agent that re-invokes this tool
			// for the same action within one execution must reuse the existing intent instead of
			// creating a duplicate. Volatile agent-authored text (reason, body) is excluded from
			// the key so a reworded retry still deduplicates.
			const idempotencyKey = idempotencyKeyParam
				|| buildExecutionScopedIdempotencyKey(
					this.getExecutionId(),
					actionType,
					normalizeGatePayload(guardianGateInput),
				);

			const result = await guardianGateCheck(
				guardianGateInput,
				credentials,
				projectSlug,
				requester,
				idempotencyKey,
				testMode,
				this.getNode(),
			);
			response.push({
				json: JSON.parse(result),
				pairedItem: { item: i },
			});
		}

		return [response];
	}
}
