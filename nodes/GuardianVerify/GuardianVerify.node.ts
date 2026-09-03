import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { guardianApiRequest, type GuardianApiCredentials } from '../shared/guardianApiRequest';

interface GuardianStatusResponse extends IDataObject {
	decision: string;
	intentRunId: string;
	actionType?: string;
	projectSlug?: string;
	idempotencyKey?: string;
	status?: string;
	decisionReason?: string;
	wouldHaveDecision?: string;
	wouldHaveDecisionNotice?: string;
	payloadJson?: IDataObject;
}

export class GuardianVerify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Enforce',
		name: 'guardianVerify',
		icon: 'file:guardian.svg',
		group: ['transform'],
		version: 1,
		description: 'Enforce a Guardian intent before executing a sensitive action',
		defaults: {
			name: 'Guardian Enforce',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://guardiansafetygate.com/docs',
					},
				],
			},
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
		],
		outputNames: ['ALLOW / OBSERVED', 'DENY', 'REQUIRE_APPROVAL', 'ERROR'],
		credentials: [
			{
				name: 'guardianApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Intent Run ID',
				name: 'intentRunId',
				type: 'string',
				default: '',
				description: 'The intentRunId returned by Guardian Agent Check. Guardian Enforce will check its real status with Guardian.',
			},
			{
				displayName: 'Execution Gate',
				name: 'claimExecution',
				type: 'options',
				default: 'claim',
				description: 'Guardian Enforce atomically authorizes this workflow as the only executor and blocks duplicate actions.',
				options: [
					{
						name: 'Verify and Claim Once (Recommended)',
						value: 'claim',
					},
					{
						name: 'Verify Status Only',
						value: 'verifyOnly',
					},
				],
			},
			{
				displayName: 'Expected Action Type',
				name: 'expectedActionType',
				type: 'string',
				default: '',
				placeholder: 'e.g. payment.send',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent matches this action type.',
			},
			{
				displayName: 'Expected Project Slug',
				name: 'expectedProjectSlug',
				type: 'string',
				default: '',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent belongs to this project.',
			},
			{
				displayName: 'Expected Idempotency Key',
				name: 'expectedIdempotencyKey',
				type: 'string',
				default: '',
				description: 'Optional. If provided, Guardian Enforce will confirm the intent was created with this idempotency key.',
			},
			{
				displayName: 'Test Mode',
				name: 'testMode',
				type: 'boolean',
				default: false,
				description: 'Whether to include the test mode header when verifying.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const allowedItems: INodeExecutionData[] = [];
		const deniedItems: INodeExecutionData[] = [];
		const approvalItems: INodeExecutionData[] = [];
		const errorItems: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('guardianApi') as unknown as GuardianApiCredentials;

		for (let i = 0; i < items.length; i++) {
			const intentRunId = this.getNodeParameter('intentRunId', i) as string;
			const claimExecution = this.getNodeParameter('claimExecution', i, 'claim') as 'claim' | 'verifyOnly';
			const expectedActionType = this.getNodeParameter('expectedActionType', i, '') as string;
			const expectedProjectSlug = this.getNodeParameter('expectedProjectSlug', i, '') as string;
			const expectedIdempotencyKey = this.getNodeParameter('expectedIdempotencyKey', i, '') as string;
			const testMode = this.getNodeParameter('testMode', i, false) as boolean;

			if (!intentRunId || intentRunId.trim() === '') {
				errorItems.push({
					json: {
						...items[i].json,
						intentRunId,
						error: 'Intent Run ID is missing. The AI agent may have skipped Guardian Agent Check or failed to include the intentRunId in its response.',
						_guardian: { decision: 'ERROR' },
					},
					pairedItem: { item: i },
				});
				continue;
			}

			const headers: Record<string, string> = {};
			if (testMode) headers['x-guardian-testmode'] = 'true';

			try {
				const response = await guardianApiRequest<GuardianStatusResponse>(credentials, {
					method: 'GET',
					path: `/v1/intents/${encodeURIComponent(intentRunId)}`,
					headers,
				});

				const originalDecision = response.decision?.toUpperCase?.() || 'ERROR';
				const status = response.status?.toUpperCase?.() || '';
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
					outputItem.json.advisoryNotice =
						response.wouldHaveDecisionNotice || 'Advisory only. Not enforced and not tamper-evident.';
				}

				if (mismatches.length > 0) {
					const guardianMeta = outputItem.json._guardian as IDataObject;
					guardianMeta.mismatches = mismatches;
					errorItems.push(outputItem);
					continue;
				}

				if (decision === 'ALLOW' && claimExecution === 'claim') {
					if (!response.payloadJson || typeof response.payloadJson !== 'object' || Array.isArray(response.payloadJson)) {
						const guardianMeta = outputItem.json._guardian as IDataObject;
						guardianMeta.verified = false;
						guardianMeta.executionClaimed = false;
						outputItem.json.error = 'Guardian returned no executable payload. Execution was blocked.';
						errorItems.push(outputItem);
						continue;
					}

					const executionResponse = await guardianApiRequest<IDataObject>(credentials, {
						method: 'POST',
						path: `/v1/intents/${encodeURIComponent(intentRunId)}/execute`,
						headers,
						body: { payload: response.payloadJson },
					});
					const guardianMeta = outputItem.json._guardian as IDataObject;
					guardianMeta.executionClaimed = executionResponse.executed === true && executionResponse.idempotent !== true;
					guardianMeta.executedAt = executionResponse.executedAt;
					if (executionResponse.idempotent === true) {
						guardianMeta.duplicateBlocked = true;
						outputItem.json.error = 'This Guardian intent was already claimed by another execution. Duplicate action blocked.';
						errorItems.push(outputItem);
						continue;
					}
					if (executionResponse.decision !== 'ALLOW' || executionResponse.executed !== true) {
						guardianMeta.verified = false;
						outputItem.json.error = 'Guardian did not authorize execution.';
						errorItems.push(outputItem);
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
					errorItems.push({
						json: {
							...items[i].json,
							...response,
							error: `Unexpected decision from Guardian: ${decision}`,
							_guardian: { decision: 'ERROR', intentRunId },
						},
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				errorItems.push({
					json: {
						...items[i].json,
						intentRunId,
						error: `Guardian verification failed: ${errorMessage}`,
						_guardian: { decision: 'ERROR', intentRunId, verified: false },
					},
					pairedItem: { item: i },
				});
			}
		}

		return [allowedItems, deniedItems, approvalItems, errorItems];
	}
}
