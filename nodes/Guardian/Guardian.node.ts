import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { createHash } from 'crypto';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { guardianApiRequest, type GuardianApiCredentials } from '../shared/guardianApiRequest';

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers (used by the Agent Gate resource)
// ─────────────────────────────────────────────────────────────────────────

interface AgentGateInput {
	actionType: string;
	payload?: Record<string, unknown>;
	amount?: number;
	recipient?: string;
	recipientDomain?: string;
	subject?: string;
	body?: string;
	reason?: string;
}

function normalizeAgentGatePayload(input: AgentGateInput): Record<string, unknown> {
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

/**
 * Parses a payload parameter that may arrive as a JSON string or an already
 * resolved object. Throws NodeOperationError on malformed JSON instead of
 * silently falling back to an empty object — an empty payload evaluated
 * against policies could produce an incorrect ALLOW/DENY decision with no
 * visible indication anything went wrong.
 */
function parsePayloadOrThrow(
	node: INode,
	payloadRaw: unknown,
	itemIndex: number,
): Record<string, unknown> {
	if (payloadRaw && typeof payloadRaw === 'object' && !Array.isArray(payloadRaw)) {
		return payloadRaw as Record<string, unknown>;
	}
	if (typeof payloadRaw === 'string' && payloadRaw.trim()) {
		try {
			return JSON.parse(payloadRaw);
		} catch {
			throw new NodeOperationError(
				node,
				'Payload must be valid JSON. Guardian evaluates policies against this data — an unparsable payload is refused rather than silently treated as empty.',
				{ itemIndex },
			);
		}
	}
	return {};
}

export class Guardian implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian',
		name: 'guardian',
		icon: { light: 'file:guardian.svg', dark: 'file:guardian.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] === "check" ? $parameter["resource"] + ": " + $parameter["operation"] : $parameter["resource"] === "enforce" ? $parameter["resource"] + ": " + $parameter["enforceOperation"] : $parameter["resource"] + ": " + $parameter["agentGateOperation"]}}',
		description: 'Policy-based safety gate for AI agents and workflows. Check actions against Guardian policies, enforce previously-evaluated intents, or gate AI agent tool calls. Returns Allowed (including OBSERVED advisory decisions), Denied, or Needs Approval.',
		defaults: {
			name: 'Guardian',
		},
		codex: {
			categories: ['AI'],
			resources: {
				primaryDocumentation: [
					{
						url: 'https://guardiansafetygate.com/docs',
					},
				],
			},
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main],
		outputNames: ['Allowed', 'Denied', 'Needs Approval'],
		credentials: [
			{
				name: 'guardianApi',
				required: true,
			},
		],
		properties: [
			// ── Resource ─────────────────────────────────────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Check',
						value: 'check',
						description: 'Evaluate an action against Guardian policies from a regular workflow step',
					},
					{
						name: 'Enforce',
						value: 'enforce',
						description: 'Verify and/or claim execution of a previously-evaluated intent (typically from an AI agent)',
					},
					{
						name: 'Agent Gate',
						value: 'agentGate',
						description: 'Use as an AI Agent tool to check (and optionally claim) an action before the agent performs it',
					},
				],
				default: 'check',
			},

			// ── Check: Operation ─────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['check'] } },
				options: [
					{
						name: 'Evaluate & Confirm',
						value: 'evaluateAndExecute',
						description: 'Most common. Checks the action and marks it as executed if allowed.',
						action: 'Evaluate and confirm an intent',
					},
					{
						name: 'Evaluate Only',
						value: 'evaluate',
						description: 'Just check the decision without marking as executed. Use for dry-runs or when you confirm later.',
						action: 'Evaluate an intent',
					},
					{
						name: 'Confirm Execution',
						value: 'execute',
						description: 'Mark a previously-approved intent as executed. Use after async approval workflows.',
						action: 'Confirm execution of an intent',
					},
					{
						name: 'Check Status',
						value: 'checkStatus',
						description: 'Poll a pending approval to see if it was approved or denied',
						action: 'Check intent status',
					},
				],
				default: 'evaluateAndExecute',
			},

			// ── Enforce: Operation ───────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'enforceOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['enforce'] } },
				options: [
					{
						name: 'Verify and Claim Once (Recommended)',
						value: 'claim',
						description: 'Guardian atomically authorizes this workflow as the only executor and blocks duplicate actions',
						action: 'Verify and claim an intent',
					},
					{
						name: 'Verify Status Only',
						value: 'verifyOnly',
						description: 'Check the intent status without claiming execution',
						action: 'Verify intent status',
					},
				],
				default: 'claim',
			},

			// ── Agent Gate: Operation ────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'agentGateOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['agentGate'] } },
				options: [
					{
						name: 'Evaluate',
						value: 'evaluate',
						description: 'Check the action against policy only. Pair with a downstream Guardian Enforce step to claim execution.',
						action: 'Evaluate an action for an AI agent',
					},
					{
						name: 'Evaluate & Claim',
						value: 'evaluateAndClaim',
						description: 'Check the action against policy and atomically claim execution in a single call. No separate Enforce step needed.',
						action: 'Evaluate and claim an action for an AI agent',
					},
				],
				default: 'evaluateAndClaim',
			},

			// ── Check: Evaluate / Evaluate & Confirm fields ──────────────────────
			{
				displayName: 'Action Type',
				name: 'actionType',
				type: 'string',
				default: '',
				required: true,
				placeholder: '{{ $json.actionType }}',
				description: 'Must match a policy in Guardian. Use an expression like {{ $JSON.actionType }} to get it from the previous node, or type a fixed value like "payment.send".',
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},
			{
				displayName: 'Payload',
				name: 'payload',
				type: 'json',
				default: '',
				required: true,
				description: 'The data your policy rules evaluate (e.g. { "amount": 5000 }). Use {{ $JSON.payload }} to pass the entire payload from the previous node, or {{ $JSON }} to pass all input data.',
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},
			{
				displayName: 'Requester',
				name: 'requester',
				type: 'string',
				default: '',
				placeholder: '{{ $json.requester }} or my-workflow',
				description: 'For audit trail. Use {{ $JSON.requester }} from input, or a fixed name like "finance-bot".',
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},
			{
				displayName: 'Project Slug',
				name: 'projectSlug',
				type: 'string',
				default: '',
				placeholder: 'e.g. finance, marketing',
				description: 'Leave empty for default project. Set to scope policies to a specific Guardian project.',
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				placeholder: '{{ $json.orderId }}',
				description: 'Prevents duplicate processing on retries. Use a unique ID from your data like {{ $JSON.orderId }} or {{ $JSON.transactionId }}.',
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},

			// ── Check: Execute (Confirm) / Check Status fields ───────────────────
			{
				displayName: 'Intent Run ID',
				name: 'intentRunId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. {{$json["intentRunId"]}}',
				description: 'The intentRunId returned by the Evaluate step',
				displayOptions: {
					show: { resource: ['check'], operation: ['execute', 'checkStatus'] },
				},
			},
			{
				displayName: 'Payload (for Integrity Check)',
				name: 'executePayload',
				type: 'json',
				default: '',
				description: 'The same payload used in the Evaluate step, required if payload hashing was enabled. Leave empty (recommended): the payload is taken automatically from the incoming item\'s payloadJson field, as sent by the Guardian Approval Trigger. Only set this to override, and then pass a stringified value, e.g. an expression wrapping JSON.stringify around the item\'s payloadJson field — passing that field directly is converted to text by n8n and will fail.',
				displayOptions: {
					show: { resource: ['check'], operation: ['execute'] },
				},
			},

			// ── Check: Options ────────────────────────────────────────────────────
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { resource: ['check'], operation: ['evaluate', 'evaluateAndExecute'] },
				},
				options: [
					{
						displayName: 'Test Mode',
						name: 'testMode',
						type: 'boolean',
						default: false,
						description: 'Whether to run this intent in test mode (does not consume quota)',
					},
				],
			},

			// ── Enforce: fields ──────────────────────────────────────────────────
			{
				displayName: 'Intent Run ID',
				name: 'enforceIntentRunId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. {{ $json.intentRunId }}',
				description: 'The intentRunId returned by Guardian Agent Gate. Enforce will check its real status with Guardian.',
				displayOptions: { show: { resource: ['enforce'] } },
			},
			{
				displayName: 'Expected Action Type',
				name: 'expectedActionType',
				type: 'string',
				default: '',
				placeholder: 'e.g. payment.send',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent matches this action type.',
				displayOptions: { show: { resource: ['enforce'] } },
			},
			{
				displayName: 'Expected Project Slug',
				name: 'expectedProjectSlug',
				type: 'string',
				default: '',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent belongs to this project.',
				displayOptions: { show: { resource: ['enforce'] } },
			},
			{
				displayName: 'Expected Idempotency Key',
				name: 'expectedIdempotencyKey',
				type: 'string',
				default: '',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent was created with this idempotency key.',
				displayOptions: { show: { resource: ['enforce'] } },
			},
			{
				displayName: 'Test Mode',
				name: 'enforceTestMode',
				type: 'boolean',
				default: false,
				description: 'Whether to include the test mode header when verifying',
				displayOptions: { show: { resource: ['enforce'] } },
			},

			// ── Agent Gate: fields ───────────────────────────────────────────────
			{
				displayName: 'Connect this tool to an AI Agent node.',
				name: 'agentGateNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Action Type',
				name: 'agentActionType',
				type: 'string',
				default: `={{ $fromAI('actionType', 'The type of action to check. Examples: "email.send", "payment.send", "data.export", "user.delete"', 'string') }}`,
				description: 'The type of action to check. Examples: "email.send", "payment.send", "data.export", "user.delete".',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Payload',
				name: 'agentPayload',
				type: 'json',
				default: `={{ $fromAI('payload', 'Complete action payload required to execute after approval. Include every exact action field.', 'json') }}`,
				description: 'Complete action payload required to execute after approval. Include every exact action field. This same payload is used for integrity verification at execution time.',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Amount',
				name: 'agentAmount',
				type: 'number',
				default: 0,
				description: 'Payment amount if applicable, e.g. 500',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Recipient',
				name: 'agentRecipient',
				type: 'string',
				default: `={{ $fromAI('recipient', 'Recipient email or identifier, e.g. "vendor@example.com"', 'string') }}`,
				description: 'Recipient email or identifier, e.g. "vendor@example.com"',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Recipient Domain',
				name: 'agentRecipientDomain',
				type: 'string',
				default: `={{ $fromAI('recipientDomain', 'Normalized recipient domain including @, e.g. "@example.com"', 'string') }}`,
				description: 'Normalized recipient domain including @, e.g. "@example.com"',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Subject',
				name: 'agentSubject',
				type: 'string',
				default: `={{ $fromAI('subject', 'Email subject if the action sends an email', 'string') }}`,
				description: 'Email subject if the action sends an email',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Body',
				name: 'agentBody',
				type: 'string',
				default: `={{ $fromAI('body', 'Complete email body if the action sends an email', 'string') }}`,
				description: 'Complete email body if the action sends an email',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Reason',
				name: 'agentReason',
				type: 'string',
				default: `={{ $fromAI('reason', 'Reason for the action', 'string') }}`,
				description: 'Reason for the action',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Tool Description',
				name: 'agentToolDescription',
				type: 'string',
				default: 'REQUIRED safety gate: Call this tool BEFORE performing any action. Pass actionType and the complete payload (recipient, subject, body, amount, etc.). Returns JSON with: decision (ALLOW/DENY/REQUIRE_APPROVAL), executed (true/false), intentRunId, actionType, payload, message. If decision is ALLOW and executed is true, the action is authorized — proceed with it. If DENY, do not proceed. If REQUIRE_APPROVAL, tell the user it is queued for approval. In your final response, output ONLY a JSON object with: intentRunId, decision, actionType, recipient, subject, body, message.',
				description: 'Description shown to the AI agent',
				typeOptions: { rows: 5 },
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Requester Name',
				name: 'agentRequester',
				type: 'string',
				default: 'n8n-ai-agent',
				description: 'Identifier for this AI agent in Guardian audit logs',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Project Slug',
				name: 'agentProjectSlug',
				type: 'string',
				default: '',
				placeholder: 'e.g. finance, marketing',
				description: 'Optional. Scope to a specific Guardian project.',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Test Mode',
				name: 'agentTestMode',
				type: 'boolean',
				default: false,
				description: 'Whether to run this intent in test mode (does not consume quota)',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
			{
				displayName: 'Idempotency Key',
				name: 'agentIdempotencyKey',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{ $json.sessionId }}',
				description: 'Optional. Prevents duplicate intents. If empty, a deterministic key is derived from this workflow execution plus the action identity (actionType, recipient, subject, amount), so repeated tool calls for the same action within one execution collapse into a single intent.',
				displayOptions: { show: { resource: ['agentGate'] } },
			},
		],
		usableAsTool: true,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const allowedItems: INodeExecutionData[] = [];
		const deniedItems: INodeExecutionData[] = [];
		const approvalItems: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('guardianApi') as unknown as GuardianApiCredentials;

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i, 'check') as 'check' | 'enforce' | 'agentGate';

			try {
				// ═══════════════════════════════════════════════════════════════
				// RESOURCE: CHECK
				// ═══════════════════════════════════════════════════════════════
				if (resource === 'check') {
					const operation = this.getNodeParameter('operation', i) as string;

					// ── EVALUATE or EVALUATE & CONFIRM ────────────────────────────
					if (operation === 'evaluate' || operation === 'evaluateAndExecute') {
						const actionType = this.getNodeParameter('actionType', i) as string;
						const payloadRaw = this.getNodeParameter('payload', i) as string;
						const requester = this.getNodeParameter('requester', i, '') as string;
						const projectSlug = this.getNodeParameter('projectSlug', i, '') as string;
						const idempotencyKey = this.getNodeParameter('idempotencyKey', i, '') as string;
						const options = this.getNodeParameter('options', i, {}) as { testMode?: boolean };

						const payload = parsePayloadOrThrow(this.getNode(), payloadRaw, i);

						const body: Record<string, unknown> = { actionType, payload };
						if (requester) body.requester = requester;
						if (projectSlug) body.projectSlug = projectSlug;

						const headers: Record<string, string> = {};
						if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
						if (options.testMode) headers['x-guardian-testmode'] = 'true';

						const evalResponse = await guardianApiRequest(credentials, {
							method: 'POST',
							path: '/v1/intents/check',
							headers,
							body,
							node: this.getNode(),
						});

						const decision = String(evalResponse.decision ?? '').toUpperCase();
						const intentRunId = String(evalResponse.intentRunId ?? '');
						const observed = decision === 'OBSERVED';

						const outputItem: INodeExecutionData = {
							json: {
								...evalResponse,
								_guardian: {
									decision,
									intentRunId,
									actionType,
									operation,
									executed: false,
									observed,
								},
							},
							pairedItem: { item: i },
						};

						if (observed) {
							outputItem.json = {
								...outputItem.json,
								message: 'OBSERVED — NOT ENFORCED. Action may proceed; this result is advisory and was not executed by Guardian.',
								advisoryDecision: evalResponse.wouldHaveDecision || null,
								advisoryNotice: evalResponse.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.',
								_guardian: {
									...(outputItem.json._guardian as Record<string, unknown>),
									executed: false,
									advisoryOnly: true,
								},
							};
							allowedItems.push(outputItem);
							continue;
						}

						// ── If ALLOW + evaluateAndExecute → auto-confirm execution ────
						if (decision === 'ALLOW' && operation === 'evaluateAndExecute') {
							const execResponse = await guardianApiRequest(credentials, {
								method: 'POST',
								path: `/v1/intents/${encodeURIComponent(intentRunId)}/execute`,
								body: { payload },
								node: this.getNode(),
							});

							if (execResponse.idempotent === true) {
								outputItem.json = {
									...outputItem.json,
									...execResponse,
									_guardian: {
										decision: 'DENY',
										intentRunId,
										actionType,
										operation,
										executed: false,
										idempotent: true,
										executedAt: execResponse.executedAt,
									},
									error: 'This Guardian intent was already executed by another run. Duplicate action blocked.',
								};
								deniedItems.push(outputItem);
							} else {
								outputItem.json = {
									...outputItem.json,
									...execResponse,
									_guardian: {
										decision,
										intentRunId,
										actionType,
										operation,
										executed: true,
										executedAt: execResponse.executedAt,
									},
								};
								allowedItems.push(outputItem);
							}
						} else if (decision === 'ALLOW') {
							allowedItems.push(outputItem);
						} else if (decision === 'DENY') {
							deniedItems.push(outputItem);
						} else {
							// REQUIRE_APPROVAL
							approvalItems.push(outputItem);
						}
					}

					// ── EXECUTE (CONFIRM) ──────────────────────────────────────────
					else if (operation === 'execute') {
						const intentRunId = this.getNodeParameter('intentRunId', i) as string;
						const executePayloadRaw = this.getNodeParameter('executePayload', i, '') as unknown;

						// n8n coerces expression results to strings when resolving parameter
						// values, so an object-valued expression such as
						// `{{ $json.payloadJson }}` arrives here as the literal string
						// "[object Object]" with the data irrecoverably lost. Detect that and
						// read the payload straight off the input item instead, which is where
						// the Guardian Approval Trigger puts it.
						const isLostObject = typeof executePayloadRaw === 'string'
							&& executePayloadRaw.trim().replace(/^=/, '') === '[object Object]';
						const itemPayload = items[i]?.json?.payloadJson;

						const execBody: Record<string, unknown> = {};
						if (executePayloadRaw && typeof executePayloadRaw === 'object' && !Array.isArray(executePayloadRaw)) {
							execBody.payload = executePayloadRaw;
						} else if (!isLostObject && typeof executePayloadRaw === 'string' && executePayloadRaw.trim()) {
							try {
								execBody.payload = JSON.parse(executePayloadRaw);
							} catch {
								throw new NodeOperationError(
									this.getNode(),
									'Execute payload must be valid JSON. Leave this field empty to use the payload from the Guardian Approval Trigger automatically, or pass a JSON string such as {{ JSON.stringify($json.payloadJson) }}.',
									{ itemIndex: i },
								);
							}
						} else if (itemPayload && typeof itemPayload === 'object' && !Array.isArray(itemPayload)) {
							execBody.payload = itemPayload;
						} else if (isLostObject) {
							throw new NodeOperationError(
								this.getNode(),
								'The payload expression resolved to "[object Object]" because n8n converts expression results to text. Leave the Payload field empty to use the approval payload from the input item automatically, or wrap it as {{ JSON.stringify($json.payloadJson) }}.',
								{ itemIndex: i },
							);
						}

						const execResponse = await guardianApiRequest(credentials, {
							method: 'POST',
							path: `/v1/intents/${encodeURIComponent(intentRunId)}/execute`,
							body: execBody,
							node: this.getNode(),
						});

						if (execResponse.idempotent === true) {
							deniedItems.push({
								json: {
									...execResponse,
									_guardian: {
										decision: 'DENY',
										intentRunId,
										executed: false,
										idempotent: true,
										executedAt: execResponse.executedAt,
									},
									error: 'This Guardian intent was already executed by another run. Duplicate action blocked.',
								},
								pairedItem: { item: i },
							});
						} else {
							allowedItems.push({
								json: {
									...execResponse,
									_guardian: {
										decision: 'ALLOW',
										intentRunId,
										executed: true,
										executedAt: execResponse.executedAt,
									},
								},
								pairedItem: { item: i },
							});
						}
					}

					// ── CHECK STATUS ─────────────────────────────────────────────────
					else if (operation === 'checkStatus') {
						const intentRunId = this.getNodeParameter('intentRunId', i) as string;

						const statusResponse = await guardianApiRequest(credentials, {
							method: 'GET',
							path: `/v1/intents/${encodeURIComponent(intentRunId)}`,
							node: this.getNode(),
						});

						const decision = String(statusResponse.decision ?? '').toUpperCase();
						const outputItem: INodeExecutionData = {
							json: {
								...statusResponse,
								_guardian: {
									decision,
									observed: decision === 'OBSERVED',
									advisoryOnly: decision === 'OBSERVED',
								},
							},
							pairedItem: { item: i },
						};

						if (decision === 'ALLOW' || decision === 'OBSERVED') allowedItems.push(outputItem);
						else if (decision === 'DENY') deniedItems.push(outputItem);
						else approvalItems.push(outputItem);
					}
				}

				// ═══════════════════════════════════════════════════════════════
				// RESOURCE: ENFORCE
				// ═══════════════════════════════════════════════════════════════
				else if (resource === 'enforce') {
					const intentRunId = this.getNodeParameter('enforceIntentRunId', i) as string;
					const claimExecution = this.getNodeParameter('enforceOperation', i, 'claim') as 'claim' | 'verifyOnly';
					const expectedActionType = this.getNodeParameter('expectedActionType', i, '') as string;
					const expectedProjectSlug = this.getNodeParameter('expectedProjectSlug', i, '') as string;
					const expectedIdempotencyKey = this.getNodeParameter('expectedIdempotencyKey', i, '') as string;
					const testMode = this.getNodeParameter('enforceTestMode', i, false) as boolean;

					if (!intentRunId || intentRunId.trim() === '') {
						deniedItems.push({
							json: {
								...items[i].json,
								intentRunId,
								error: 'Intent Run ID is missing. The AI agent may have skipped Guardian Agent Gate or failed to include the intentRunId in its response.',
								_guardian: { decision: 'ERROR' },
							},
							pairedItem: { item: i },
						});
						continue;
					}

					const headers: Record<string, string> = {};
					if (testMode) headers['x-guardian-testmode'] = 'true';

					const response = await guardianApiRequest<Record<string, unknown>>(credentials, {
						method: 'GET',
						path: `/v1/intents/${encodeURIComponent(intentRunId)}`,
						headers,
						node: this.getNode(),
					});

					const originalDecision = String(response.decision ?? '').toUpperCase() || 'ERROR';
					const status = String(response.status ?? '').toUpperCase();
					let decision = originalDecision;
					if (status === 'APPROVED') decision = 'ALLOW';
					if (['DENIED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(status)) decision = 'DENY';
					if (['AWAITING_APPROVAL', 'PENDING'].includes(status)) decision = 'REQUIRE_APPROVAL';
					const observed = decision === 'OBSERVED';

					const mismatches: string[] = [];
					if (expectedActionType && response.actionType !== expectedActionType) {
						mismatches.push(`actionType expected ${expectedActionType}, got ${response.actionType || 'missing'}`);
					}
					if (expectedProjectSlug && response.projectSlug !== expectedProjectSlug) {
						mismatches.push(`projectSlug expected ${expectedProjectSlug}, got ${response.projectSlug || 'missing'}`);
					}
					if (expectedIdempotencyKey && response.idempotencyKey !== expectedIdempotencyKey) {
						mismatches.push('idempotencyKey mismatch');
					}

					const inputJson = items[i].json as Record<string, unknown>;
					const outputItem: INodeExecutionData = {
						json: {
							...inputJson,
							...response,
							_guardian: {
								decision,
								originalDecision,
								status,
								intentRunId: response.intentRunId || intentRunId,
								verified: mismatches.length === 0,
								observed,
								advisoryOnly: observed,
							},
						},
						pairedItem: { item: i },
					};

					if (observed) {
						outputItem.json.message = 'OBSERVED — NOT ENFORCED. Action may proceed; this status is advisory only.';
						outputItem.json.advisoryDecision = response.wouldHaveDecision || null;
						outputItem.json.advisoryNotice = response.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.';
					}

					if (mismatches.length > 0) {
						(outputItem.json._guardian as Record<string, unknown>).mismatches = mismatches;
						outputItem.json.error = 'Guardian Enforce field mismatch — see _guardian.mismatches for details.';
						deniedItems.push(outputItem);
						continue;
					}

					if (decision === 'ALLOW' && claimExecution === 'claim') {
						if (!response.payloadJson || typeof response.payloadJson !== 'object' || Array.isArray(response.payloadJson)) {
							(outputItem.json._guardian as Record<string, unknown>).verified = false;
							(outputItem.json._guardian as Record<string, unknown>).executionClaimed = false;
							outputItem.json.error = 'Guardian returned no executable payload. Execution was blocked.';
							deniedItems.push(outputItem);
							continue;
						}

						const executionResponse = await guardianApiRequest<Record<string, unknown>>(credentials, {
							method: 'POST',
							path: `/v1/intents/${encodeURIComponent(intentRunId)}/execute`,
							headers,
							body: { payload: response.payloadJson },
							node: this.getNode(),
						});
						const guardianMeta = outputItem.json._guardian as Record<string, unknown>;
						guardianMeta.executionClaimed = executionResponse.executed === true && executionResponse.idempotent !== true;
						guardianMeta.executedAt = executionResponse.executedAt;
						if (executionResponse.idempotent === true) {
							guardianMeta.duplicateBlocked = true;
							outputItem.json.error = 'This Guardian intent was already claimed by another execution. Duplicate action blocked.';
							deniedItems.push(outputItem);
							continue;
						}
						if (executionResponse.decision !== 'ALLOW' || executionResponse.executed !== true) {
							guardianMeta.verified = false;
							outputItem.json.error = 'Guardian did not authorize execution.';
							deniedItems.push(outputItem);
							continue;
						}
					}

					if (decision === 'ALLOW' || decision === 'OBSERVED') {
						allowedItems.push(outputItem);
					} else if (decision === 'DENY') {
						deniedItems.push(outputItem);
					} else if (decision === 'REQUIRE_APPROVAL') {
						approvalItems.push(outputItem);
					} else {
						outputItem.json.error = `Unexpected decision from Guardian: ${decision}`;
						deniedItems.push(outputItem);
					}
				}

				// ═══════════════════════════════════════════════════════════════
				// RESOURCE: AGENT GATE
				// ═══════════════════════════════════════════════════════════════
				else if (resource === 'agentGate') {
					const operation = this.getNodeParameter('agentGateOperation', i, 'evaluateAndClaim') as 'evaluate' | 'evaluateAndClaim';
					const projectSlug = this.getNodeParameter('agentProjectSlug', i, '') as string;
					const requester = this.getNodeParameter('agentRequester', i, 'n8n-ai-agent') as string;
					const idempotencyKeyParam = this.getNodeParameter('agentIdempotencyKey', i, '') as string;
					const testMode = this.getNodeParameter('agentTestMode', i, false) as boolean;

					const actionType = this.getNodeParameter('agentActionType', i, '') as string;
					const payloadRaw = this.getNodeParameter('agentPayload', i, {}) as unknown;
					const parsedPayload = parsePayloadOrThrow(this.getNode(), payloadRaw, i);

					const amountRaw = this.getNodeParameter('agentAmount', i, undefined) as number | string | undefined;
					const amount = amountRaw === undefined || amountRaw === '' ? undefined : Number(amountRaw);
					const recipient = this.getNodeParameter('agentRecipient', i, '') as string;
					const recipientDomain = this.getNodeParameter('agentRecipientDomain', i, '') as string;
					const subject = this.getNodeParameter('agentSubject', i, '') as string;
					const body = this.getNodeParameter('agentBody', i, '') as string;
					const reason = this.getNodeParameter('agentReason', i, '') as string;

					const agentInput: AgentGateInput = {
						actionType,
						payload: parsedPayload,
						amount,
						recipient,
						recipientDomain,
						subject,
						body,
						reason,
					};
					const payload = normalizeAgentGatePayload(agentInput);

					// Deterministic execution-scoped idempotency: an AI agent that re-invokes
					// this tool for the same action within one execution must reuse the
					// existing intent instead of creating a duplicate. Volatile agent-authored
					// text (reason, body) is excluded from the key so a reworded retry still
					// deduplicates.
					const idempotencyKey = idempotencyKeyParam
						|| buildExecutionScopedIdempotencyKey(this.getExecutionId(), actionType, payload);

					const requestBody: Record<string, unknown> = { actionType, payload, requester };
					if (projectSlug) requestBody.projectSlug = projectSlug;

					const headers: Record<string, string> = {};
					if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
					if (testMode) headers['x-guardian-testmode'] = 'true';

					let evalResult: {
						decision: string;
						intentRunId: string;
						decisionReason?: string;
						wouldHaveDecision?: string;
						wouldHaveDecisionNotice?: string;
					};
					try {
						evalResult = await guardianApiRequest(credentials, {
							method: 'POST',
							path: '/v1/intents/check',
							headers,
							body: requestBody,
							node: this.getNode(),
						});
					} catch (checkError) {
						// Agent Gate is consumed directly by an AI agent as a tool. Throwing
						// here would halt the whole workflow; instead return a graceful ERROR
						// JSON so the agent can decide how to proceed (matches the original
						// GuardianTool/GuardianGate behavior).
						deniedItems.push({
							json: {
								decision: 'ERROR',
								canProceed: false,
								executed: false,
								actionType,
								payload,
								error: checkError instanceof Error ? checkError.message : 'Unknown error',
								message: 'Guardian safety check failed. Do NOT proceed.',
							},
							pairedItem: { item: i },
						});
						continue;
					}

					const decision = (evalResult.decision || '').toUpperCase();
					const intentRunId = evalResult.intentRunId;

					if (decision === 'OBSERVED') {
						allowedItems.push({
							json: {
								decision: 'OBSERVED',
								canProceed: true,
								executed: false,
								intentRunId,
								actionType,
								payload,
								message: 'OBSERVED — NOT ENFORCED. Action may proceed; Guardian did not execute this intent.',
								advisoryDecision: evalResult.wouldHaveDecision || null,
								advisoryNotice: evalResult.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.',
							},
							pairedItem: { item: i },
						});
						continue;
					}

					if (decision === 'DENY') {
						deniedItems.push({
							json: {
								decision: 'DENY',
								canProceed: false,
								executed: false,
								message: `Action DENIED. Reason: ${evalResult.decisionReason || 'Policy violation'}`,
								intentRunId,
								actionType,
								payload,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					if (decision !== 'ALLOW') {
						// REQUIRE_APPROVAL
						approvalItems.push({
							json: {
								decision: 'REQUIRE_APPROVAL',
								canProceed: false,
								executed: false,
								message: 'This action requires human approval. It has been submitted for approval.',
								intentRunId,
								actionType,
								payload,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					// decision === 'ALLOW'
					if (operation === 'evaluate') {
						allowedItems.push({
							json: {
								decision: 'ALLOW',
								canProceed: true,
								executed: false,
								message: 'Action is allowed but NOT executed. Pass intentRunId to a downstream Guardian Enforce step.',
								intentRunId,
								actionType,
								payload,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					// operation === 'evaluateAndClaim'
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
							node: this.getNode(),
						});

						if (execResult.idempotent === true) {
							deniedItems.push({
								json: {
									decision: 'ALLOW',
									canProceed: false,
									executed: false,
									duplicateBlocked: true,
									intentRunId,
									actionType,
									payload,
									message: 'This action was already executed. Duplicate blocked by Guardian.',
								},
								pairedItem: { item: i },
							});
							continue;
						}

						allowedItems.push({
							json: {
								decision: 'ALLOW',
								canProceed: true,
								executed: execResult.executed === true,
								intentRunId,
								actionType,
								payload,
								executedAt: execResult.executedAt,
								message: 'Action allowed and execution claimed. Proceed with the action.',
							},
							pairedItem: { item: i },
						});
					} catch (execError) {
						deniedItems.push({
							json: {
								decision: 'ERROR',
								canProceed: false,
								executed: false,
								intentRunId,
								actionType,
								payload,
								error: `Execution claim failed: ${execError instanceof Error ? execError.message : 'Unknown error'}`,
								message: 'Guardian allowed the action but execution claim failed. Do NOT proceed.',
							},
							pairedItem: { item: i },
						});
					}
				}

			} catch (error: unknown) {
				if (this.continueOnFail()) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					deniedItems.push({
						json: { error: errorMessage, _guardian: { decision: 'ERROR' } },
						pairedItem: { item: i },
					});
				} else {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error : 'Guardian request failed',
						{ itemIndex: i },
					);
				}
			}
		}

		return [allowedItems, deniedItems, approvalItems];
	}
}
