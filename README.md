# n8n-nodes-guardian

Official n8n community node for **[Guardian Safety Gate](https://guardiansafetygate.com)** — the policy decision layer for AI agents, workflows, and backends.

Guardian decides whether an action is allowed **before** it runs. It does not perform the action itself. Use it to require human approval for high-risk operations, block forbidden actions, or log everything for compliance.

---

## What it does

Place the **Guardian** node in your workflow **between the decision point and any sensitive action** (payments, deletions, emails, AI tool calls, etc.). It checks the action against your policies and routes your workflow to one of three outputs:

| Output | Meaning | What your workflow does next |
|---|---|---|
| ✅ **Allowed** | Action passed all policies | Continue and execute the action yourself |
| ❌ **Denied** | Action was blocked by a policy rule (or the check itself failed) | Stop, log, or handle the block |
| ⏳ **Needs Approval** | A human must approve first | Pause and wait for the approval webhook |

> **Guardian evaluates; your workflow executes.** The payment, email, deletion, or API call is still performed by your own n8n nodes.

The node exposes three **resources**, selectable from a dropdown:

| Resource | Use for |
|---|---|
| **Check** | Regular (non-AI) workflow steps: evaluate an action, confirm execution, or poll approval status |
| **Enforce** | Verifying and atomically claiming execution of an intent created elsewhere (typically by an AI agent via Agent Gate) |
| **Agent Gate** | Wiring directly into an AI Agent as a tool (`usableAsTool: true`) — the agent calls it via `$fromAI()` before performing an action |

---

## Resource: Check — Operations

### Evaluate & Confirm *(recommended)*
Check the action with Guardian and, if allowed, record the decision. Use this for most workflows. After the "Allowed" branch, connect your own execution node (HTTP Request, Send Email, Delete Row, etc.).

### Evaluate Only
Get the decision without recording it. Use when you want to inspect the decision or route the workflow manually before confirming.

### Confirm Execution
Tell Guardian that an already-approved intent was executed by your workflow. This completes the audit trail.

### Check Status
Poll for the current status of a pending approval.

---

## Resource: Enforce — Operations

### Verify and Claim Once (Recommended)
Fetches the authoritative intent status from Guardian, optionally validates expected identity fields (action type, project, idempotency key), and atomically claims execution — blocking duplicate/replayed executions.

### Verify Status Only
Checks the intent status without claiming execution.

---

## Resource: Agent Gate — Operations

Connect this resource directly to an AI Agent node's tool input (the node is `usableAsTool: true`). Fields default to `$fromAI()` expressions so the agent supplies them automatically.

### Evaluate
Checks the action against policy only. Pair with a downstream **Guardian → Enforce** step to claim execution once the agent's response has been validated.

### Evaluate & Claim
Checks the action against policy and atomically claims execution in a single call — no separate Enforce step needed.

---

## Requirements

- **Self-hosted or local n8n only.** Community nodes are not supported on n8n Cloud.
- You need a Guardian API key from your Guardian dashboard.

## Setup

### 1. Install the node
In your n8n instance go to **Settings → Community Nodes → Install** and enter:
```
n8n-nodes-guardian
```

Or install via terminal from your n8n directory:
```bash
npm install n8n-nodes-guardian
```

### 2. Create credentials
- Create an API key in **Guardian → Settings → API Keys**.
- For production, enable **Require Signing** and save both one-time values.
- Go to **Credentials → New → Guardian API** in n8n.
- Paste the `gk_...` value into **API Key**.
- Paste the `gs_...` value into **API Signing Secret**. Leave it blank only for unsigned development keys.
- Set **Base URL** to your Guardian API origin.

Every Guardian node automatically signs API requests with a fresh timestamp and nonce when the credential contains an API signing secret.

### 3. Add to workflow
Drop the **Guardian** node (Resource: **Check**) before any sensitive action. For AI agents, use the same node with Resource: **Agent Gate** as a tool, Resource: **Enforce** to validate and claim, and the separate **Guardian Approval Trigger** node as shown below.

---

## Example Workflow

```text
[Trigger] → [Guardian: Check → Evaluate & Confirm]
                 ├─ Allowed ─────────────→ [Execute action]
                 ├─ Denied ──────────────→ [Stop + log]
                 └─ Needs Approval ──────→ [Return queued]

[Guardian Approval Trigger] → [Guardian: Enforce + atomic claim] → [Execute action]
```

No Wait node or polling loop is required. Activating **Guardian Approval Trigger** registers its signed callback automatically; deactivating it removes the callback.

---

## AI Agent Pattern: Tool + Structured Output + Hard Gate

Use a Structured Output Parser rather than regex or marker parsing.

```text
[Chat Trigger] → [AI Agent] ← [Guardian: Agent Gate (tool)]
                      ↑      ← [Conversation Memory]
                      ↑      ← [Structured Output Parser]
                      ↓
             [Fail-closed validation]
                      ↓
       [Guardian: Enforce + atomic execution claim]
           ├─ Allowed ─────────────→ [Execute Guardian payload]
           ├─ Denied ──────────────→ [Stop] (also catches errors)
           └─ Needs Approval ──────→ [Return queued]

[Guardian Approval Trigger] ───────→ [same Guardian: Enforce + claim gate]
```

### Enforcement properties

- **Guardian: Agent Gate** creates the server-side intent using the complete action payload.
- **Structured Output Parser** gives the agent a schema, while a normal Code node validates required identity fields and fails closed.
- **Guardian: Enforce** ignores the model's claimed decision, fetches the authoritative intent, validates expected identity fields, and atomically claims execution.
- A duplicate or replayed execution is routed to Denied rather than the action node.
- The action node must read `payloadJson` returned by Guardian instead of untrusted model fields.
- **Guardian Approval Trigger** HMAC-verifies approval events and starts a fresh execution after approval.

The importable `demo/guardian-email-autopilot-workflow.json` workflow implements this complete pattern.

---

## HMAC Channels

Guardian uses two independent signing directions:

- **API signing:** n8n signs requests to Guardian using the `gs_...` secret stored in the Guardian API credential.
- **Webhook signing:** Guardian signs approval callbacks using a separate secret generated and registered automatically by Guardian Approval Trigger.

Do not paste the API signing secret into Guardian's manual webhook form. The trigger owns its callback lifecycle and signing secret.

---

## Payload Tips

The `payload` field should be a JSON object matching your policy rules. Example:

```json
{
  "amount": 4500,
  "currency": "USD",
  "recipient": "vendor-acme",
  "category": "marketing"
}
```

Your Guardian policy rules match against these fields (e.g. "block if amount > 5000").

---

## Support

- Docs: https://guardiansafetygate.com/docs
- Issues: Open a GitHub issue on this repo
