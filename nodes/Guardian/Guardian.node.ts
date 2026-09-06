import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { guardianApiRequest, type GuardianApiCredentials } from '../shared/guardianApiRequest';

export class Guardian implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Check',
		name: 'guardian',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Policy-based safety gate. Wire actionType and payload from your previous node (AI agent, webhook, etc). Returns Allowed (including OBSERVED advisory decisions), Denied, or Needs Approval.',
		defaults: {
			name: 'Guardian Check',
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
			// ── Operation ────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
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

			// ── Evaluate / Evaluate & Confirm fields ─────────────────────────────
			{
				displayName: 'Action Type',
				name: 'actionType',
				type: 'string',
				default: '',
				required: true,
				placeholder: '{{ $json.actionType }}',
				description: 'Must match a policy in Guardian. Use an expression like {{ $JSON.actionType }} to get it from the previous node, or type a fixed value like "payment.send".',
				displayOptions: {
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
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
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
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
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
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
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
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
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
				},
			},

			// ── Execute (Confirm) fields ──────────────────────────────────────────
			{
				displayName: 'Intent Run ID',
				name: 'intentRunId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. {{$json["intentRunId"]}}',
				description: 'The intentRunId returned by the Evaluate step',
				displayOptions: {
					show: { operation: ['execute', 'checkStatus'] },
				},
			},
			{
				displayName: 'Payload (for Integrity Check)',
				name: 'executePayload',
				type: 'json',
				default: '',
				description: 'The same payload used in the Evaluate step, required if payload hashing was enabled. Leave empty (recommended): the payload is taken automatically from the incoming item\'s payloadJson, as sent by the Guardian Approval Trigger. Only set this to override, and then use a JSON string such as {{ JSON.stringify($json.payloadJson) }} — a bare {{ $json.payloadJson }} is converted to text by n8n and will fail.',
				displayOptions: {
					show: { operation: ['execute'] },
				},
			},

			// ── Options ───────────────────────────────────────────────────────────
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { operation: ['evaluate', 'evaluateAndExecute'] },
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
			const operation = this.getNodeParameter('operation', i) as string;

			try {
				// ── EVALUATE or EVALUATE & CONFIRM ────────────────────────────────
				if (operation === 'evaluate' || operation === 'evaluateAndExecute') {
					const actionType = this.getNodeParameter('actionType', i) as string;
					const payloadRaw = this.getNodeParameter('payload', i) as string;
					const requester = this.getNodeParameter('requester', i, '') as string;
					const projectSlug = this.getNodeParameter('projectSlug', i, '') as string;
					const idempotencyKey = this.getNodeParameter('idempotencyKey', i, '') as string;
					const options = this.getNodeParameter('options', i, {}) as { testMode?: boolean };

					let payload: Record<string, unknown>;
					try {
						payload = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
					} catch {
						throw new NodeOperationError(this.getNode(), 'Payload must be valid JSON', { itemIndex: i });
					}

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

				// ── EXECUTE (CONFIRM) ──────────────────────────────────────────────
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

				// ── CHECK STATUS ───────────────────────────────────────────────────
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
