import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { guardianApiRequest, type GuardianApiCredentials } from '../shared/guardianApiRequest';

interface GuardianWebhookRecord extends IDataObject {
	id: string;
	url: string;
	events: string[];
	enabled: boolean;
	workflowId?: string;
	nodeId?: string;
	actionTypeFilter?: string | null;
}

interface GuardianWebhookListResponse extends IDataObject {
	webhooks: GuardianWebhookRecord[];
}

interface GuardianWebhookCreateResponse extends IDataObject {
	webhook: GuardianWebhookRecord;
}

interface GuardianWebhookStaticData extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
	webhookUrl?: string;
}

async function guardianRequest(
	context: IHookFunctions,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const credentials = await context.getCredentials('guardianApi') as unknown as GuardianApiCredentials;
	return await guardianApiRequest<IDataObject>(credentials, {
		method,
		path,
		body,
		node: context.getNode(),
	});
}

function sameEvents(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && expected.every((event) => actual.includes(event));
}

export class GuardianApprovalTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Guardian Approval Trigger',
		name: 'guardianApprovalTrigger',
		icon: 'file:guardian.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '',
		description: 'Automatically continue workflows when a Guardian approval is resolved',
		defaults: {
			name: 'Guardian Approval Trigger',
		},
		codex: {
			categories: ['Core Nodes'],
			subcategories: {
				'Core Nodes': ['Helpers'],
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
		outputs: [NodeConnectionTypes.Main],
		outputNames: ['Approval Event'],
		credentials: [
			{
				name: 'guardianApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '=guardian/approval-resolved/{{$workflow.id}}/{{$nodeId}}',
			},
		],
		properties: [
			{
				displayName: 'Activate this workflow and Guardian will connect automatically. Each trigger node receives its own workflow-specific webhook URL.',
				name: 'automaticSetupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Include Rejected or Cancelled',
				name: 'includeRejected',
				type: 'boolean',
				default: false,
				description: 'Whether to start the workflow for rejected, denied, cancelled, or expired approvals. Approved events always start the workflow.',
			},
			{
				displayName: 'Action Type Filter',
				name: 'actionTypeFilter',
				type: 'string',
				default: '',
				placeholder: 'e.g. po_extraction.sheet_append',
				description: 'Only trigger for approvals matching this action type. Leave blank to receive all approval events for this organization.',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) {
					throw new NodeOperationError(this.getNode(), 'n8n could not generate the Guardian webhook URL');
				}

				const staticData = this.getWorkflowStaticData('node') as GuardianWebhookStaticData;
				if (!staticData.webhookId || !staticData.webhookSecret) return false;

				const response = await guardianRequest(this, 'GET', '/v1/admin/webhooks') as GuardianWebhookListResponse;
				const events = ['approval_resolved'];
				const existing = (response.webhooks ?? []).find((webhook) => webhook.id === staticData.webhookId);
				if (!existing || existing.url !== webhookUrl || !existing.enabled || !sameEvents(existing.events, events)) {
					return false;
				}

				// Legacy registrations predate server-side binding and lack ownership.
				// Force re-registration so Guardian stores the (workflowId, nodeId) binding.
				if (existing.workflowId !== this.getWorkflow().id || existing.nodeId !== this.getNode().id) {
					return false;
				}
				const storedFilter = String(existing.actionTypeFilter ?? '').trim().toLowerCase();
				const desiredFilter = (this.getNodeParameter('actionTypeFilter', '') as string).trim().toLowerCase();
				if (storedFilter !== desiredFilter) {
					return false;
				}

				staticData.webhookUrl = webhookUrl;
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				if (!webhookUrl) {
					throw new NodeOperationError(this.getNode(), 'n8n could not generate the Guardian webhook URL');
				}
				if (!webhookUrl.startsWith('https://')) {
					throw new NodeOperationError(this.getNode(), 'Guardian Approval Trigger requires a public HTTPS n8n webhook URL');
				}

				const staticData = this.getWorkflowStaticData('node') as GuardianWebhookStaticData;
				if (staticData.webhookId && staticData.webhookUrl && staticData.webhookUrl !== webhookUrl) {
					try {
						await guardianRequest(this, 'DELETE', `/v1/admin/webhooks/${encodeURIComponent(staticData.webhookId)}`);
					} catch (error) {
						// The stale registration may already have been removed — log and continue.
						this.logger.error('Guardian Approval Trigger: failed to delete stale webhook registration', { error });
					}
				}

				const list = await guardianRequest(this, 'GET', '/v1/admin/webhooks') as GuardianWebhookListResponse;
				for (const webhook of list.webhooks ?? []) {
					if (webhook.url === webhookUrl) {
						await guardianRequest(this, 'DELETE', `/v1/admin/webhooks/${encodeURIComponent(webhook.id)}`);
					}
				}

				const workflowId = this.getWorkflow().id;
				if (!workflowId) {
					throw new NodeOperationError(this.getNode(), 'Save this workflow once before activating so Guardian can bind the registration to it');
				}
				const actionTypeFilter = (this.getNodeParameter('actionTypeFilter', '') as string).trim();

				const webhookSecret = `whs_${randomBytes(32).toString('hex')}`;
				let response: GuardianWebhookCreateResponse;
				try {
					response = await guardianRequest(this, 'POST', '/v1/admin/webhooks', {
						url: webhookUrl,
						events: ['approval_resolved'],
						enabled: true,
						signingSecret: webhookSecret,
						workflowId,
						nodeId: this.getNode().id,
						actionTypeFilter: actionTypeFilter || undefined,
					}) as GuardianWebhookCreateResponse;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes('(409)')) {
						throw new NodeOperationError(
							this.getNode(),
							`${message} Deactivate the other workflow's Guardian Approval Trigger (or change this node's Action Type Filter), then activate again.`,
						);
					}
					throw new NodeOperationError(this.getNode(), error instanceof Error ? error : message);
				}

				if (!response.webhook?.id) return false;

				staticData.webhookId = response.webhook.id;
				staticData.webhookSecret = webhookSecret;
				staticData.webhookUrl = webhookUrl;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as GuardianWebhookStaticData;
				if (staticData.webhookId) {
					try {
						await guardianRequest(this, 'DELETE', `/v1/admin/webhooks/${encodeURIComponent(staticData.webhookId)}`);
					} catch (error) {
						this.logger.error('Guardian Approval Trigger: failed to delete webhook on deactivation', { error });
						return false;
					}
				}

				delete staticData.webhookId;
				delete staticData.webhookSecret;
				delete staticData.webhookUrl;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		const headers = this.getHeaderData();
		const request = this.getRequestObject() as unknown as {
			rawBody?: Buffer | string;
		};
		const staticData = this.getWorkflowStaticData('node') as GuardianWebhookStaticData;
		const secret = staticData.webhookSecret;
		const signatureHeader = headers['x-guardian-webhook-signature'];
		const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
		const rawBody = request.rawBody
			? Buffer.isBuffer(request.rawBody) ? request.rawBody.toString('utf8') : request.rawBody
			: JSON.stringify(body);

		const expected = secret ? createHmac('sha256', secret).update(rawBody).digest('hex') : '';
		const validSignature = Boolean(
			secret &&
			typeof signature === 'string' &&
			signature.length === expected.length &&
			timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
		);

		if (!validSignature) {
			const response = this.getResponseObject();
			response.status(401).send('Invalid Guardian webhook signature').end();
			return { noWebhookResponse: true };
		}

		if (body.event !== 'approval_resolved') {
			return { webhookResponse: { received: true, ignored: true } };
		}

		const actionTypeFilter = (this.getNodeParameter('actionTypeFilter', '') as string).trim().toLowerCase();
		if (actionTypeFilter && String(body.actionType ?? '').toLowerCase() !== actionTypeFilter) {
			return { webhookResponse: { received: true, ignored: true } };
		}

		const status = String(body.status ?? '').toUpperCase();
		const includeRejected = this.getNodeParameter('includeRejected', false) as boolean;
		const approved = status === 'APPROVED';
		const terminalRejected = ['REJECTED', 'DENIED', 'CANCELLED', 'EXPIRED'].includes(status);
		if (!approved && !(includeRejected && terminalRejected)) {
			return { webhookResponse: { received: true, ignored: true } };
		}

		return {
			webhookResponse: { received: true, intentRunId: body.intentRunId },
			workflowData: [[{
				json: {
					...body,
					_guardianWebhook: {
						verified: true,
						event: body.event,
						deliveryAttempt: headers['x-guardian-delivery-attempt'] ?? null,
						receivedAt: new Date().toISOString(),
					},
				},
			}]],
		};
	}
}
