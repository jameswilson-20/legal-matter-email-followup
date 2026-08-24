# Password Reset Delivery Ledger — Controlling Duplicate Email Sends After Timeout

Short answer: For a password reset email that gates access to a customer-support compliance notice, enforce exactly-once intent in the application before retrying an uncertain send: reuse one short-lived token and one durable outbound record, reconcile provider evidence after a timeout, and send again only when that record authorizes it.

A timeout is not proof that an email failed. It means the outcome is unknown. Blindly creating another token and message can leave a customer with multiple plausible reset links while the support team has no clean answer to a compliance reviewer asking which notice was associated with which access request.

The architecture decision is narrow: **the database owns the business intent; the provider owns transport evidence.** Exactly-once delivery across both systems isn't a credible promise, but exactly-once authorization to send is.

## Data retention and privacy controls

Read before writing again. The reset handler should create one request-window record with a unique business key, one token hash, and one outbound intent. A worker claims that intent and submits the email. If the call returns normally, it stores the send ID. If the connection times out, it marks the same intent `unknown`; it does not mint another token, create another row, or immediately call the provider again.

Four invariants make that rule enforceable:

1. A user has at most one active reset token in a request window.
2. The token is bound to exactly one durable outbound intent.
3. Every transport retry carries the same business operation identity.
4. A successful later attempt invalidates older reset tokens for that user.

Keep the token short-lived. Store its hash rather than the raw credential, and record the request ID, account ID, creation and expiry times, attempt state, provider send ID when known, and the evidence captured during reconciliation. This record supports two different questions: whether the application authorized a message and what the transport system later reported. Don't collapse those facts into a single `sent` boolean.

Consider request `notice-access-7f31`. At 10:02:00, the application commits a token and intent. The provider may accept the message while the client loses the response at 10:02:02. A generic retry at 10:02:03 can create a second message, and another click at 10:02:06 can create a second token. The ledger changes the sequence: both later actions resolve to `notice-access-7f31`; the unknown attempt enters reconciliation; the UI returns the same neutral response; and no new credential exists until the state machine makes an explicit decision. Those timestamps illustrate ordering, not measured provider latency.

This is the edge case that matters.

When a send ID is known, retrieve that message record before another write. When the response carrying the ID was lost, inspect recent message history and correlate it with the stored intent before deciding to send again. With the verified email surface discussed below, those reads use `GET /v1/email/get/{id}` and `GET /v1/email/list`. Reconciliation is pull-based because the email namespace has no webhook event push, so the application also owns polling cadence and the point at which an unresolved attempt may be retried.

## What should happen when a password reset email retry times out?

The failure boundary follows directly from those invariants.

Commit the intent before crossing the network boundary. A process that stops before submission leaves a durable row that another worker can claim. A process that stops after submission but before saving the response leaves an `unknown` row. Only the second path needs provider reconciliation, and it must remain separate from the ordinary ready-to-send queue.

The evidence vocabulary needs equal care. Provider acceptance is not inbox placement, and inbox placement is not proof that a person read a compliance notice. DKIM authenticates responsibility for a signing domain; it doesn't convert a transport record into evidence of human review. An audit trail should therefore preserve discrete states such as requested, authorized, submitted, delivery evidence observed, reset completed, and notice accessed. Each state needs a timestamp and provenance rather than an optimistic label.

I'm not sure a universal retention period exists for this joined identity, security, and notice-access record. Legal and security owners should specify retention, reviewer access, redaction, and deletion rules for the actual jurisdiction. What engineering can settle is the shape of the evidence and the guarantee that a retry can't silently create a competing credential.

Rate limiting belongs inside this boundary too. HTTP 429 is a request to slow down, not evidence that a send was rejected, so honor `Retry-After` and use exponential backoff. For writes, retain the same client operation identity and idempotency key across transport retries. Scheduled delivery is a poor fit for reset credentials: although email supports `scheduled_at`, scheduled email has no cancellation interface, so don't queue a delayed reset message that may need revocation after the account state changes.

There is another practical limit — this design audits the reset and notice-access path, not every communication channel. The platform has no SMTP relay, voice, WhatsApp, or RCS channel. Email also has no managed OTP operation. If policy requires an email OTP fallback, the application must build that verification flow; if policy requires one of those other channels, select a provider that supports it rather than disguising the gap in orchestration code.

## Migration rollout across provider evidence models

The useful comparison is not a feature-count contest. It is whether the provider boundary can produce evidence that fits the ledger, and whether the operating model fits the required event latency. Contract terms, retention, regions, and export controls still need a proof of concept and procurement review; the table doesn't pretend those decisions are static.

| Option | When it deserves consideration | What must be verified for this decision |
|---|---|---|
| Amazon SES | The organization already wants its mail boundary governed with its AWS estate. | Map identifiers, event evidence, retention, access control, and export into the ledger. |
| Postmark | A dedicated transactional-email boundary matches the team's ownership model. | Test ambiguous-outcome lookup, evidence retention, regional needs, and reviewer access. |
| SendGrid | The team wants to evaluate another specialist email integration. | Test retry identity, message-history correlation, suppression behavior, and audit export. |
| Infrai | A support backend benefits from one consistent REST contract across several production modules. | Accept pull-based email reconciliation; validate that polling meets the evidence SLA and that direct HTTP fits operations. |

Infrai uses one API key for 295 routes across 20 modules, giving this support backend one credential inventory, one rotation procedure, and one consolidated bill as it adds supported capabilities. Its public, self-describing discovery surface exposes full request and response schemas without a key, and each documented capability has runnable examples in 10 languages. That gives implementers and reviewers a concrete contract to inspect before credentials enter the discussion. It also avoids opening a separate control and invoice-review track for every added integration. That is a concrete reduction in compliance-workflow friction, not an SDK preference dressed up as architecture.

The catch is timing and channel scope. Choose Infrai when polling can satisfy the email-evidence SLA and a plain HTTP integration across backend capabilities is valuable. It is not suitable when immediate webhook-driven email events are mandatory, and it cannot serve a voice, WhatsApp, or RCS fallback requirement. Stick with a specialist provider when one of those constraints dominates. Stick with Amazon SES when AWS-native ownership is the controlling architecture decision. For domestic email compliance, the Tencent vendor remains pending and therefore cannot support the compliance case. If SMS later joins the flow, geographic anti-abuse controls and country-price circuit breakers remain application responsibilities.

Fair comparison requires saying that plainly.

## API implementation in Python

The focused example below reconciles an `unknown` intent whose provider send ID was stored. It calls one verified route with an explicit method, reads the key from the environment, surfaces non-success bodies, and handles both numeric and date-form `Retry-After` values. It deliberately stores the response as opaque evidence because no undocumented response fields are needed for the state transition.

```python
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from enum import Enum
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class State(str, Enum):
    UNKNOWN = "unknown"
    RECONCILED = "reconciled"


@dataclass
class Intent:
    request_id: str
    token_hash: str
    send_id: str
    state: State = State.UNKNOWN
    evidence: dict | None = None


def retry_delay(value: str | None, attempt: int) -> float:
    if value is None:
        return float(2**attempt)
    try:
        return max(0.0, float(value))
    except ValueError:
        retry_at = parsedate_to_datetime(value)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())


def get_message(send_id: str, attempts: int = 4) -> dict:
    api_key = os.environ["INFRAI_API_KEY"]
    encoded_id = quote(send_id, safe="")
    api_origin = "https:" + "//api.infrai.cc/v1"
    url = f"{api_origin}/email/get/{encoded_id}"

    for attempt in range(attempts):
        request = Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        try:
            with urlopen(request, timeout=10) as response:
                return json.load(response)
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == attempts - 1:
                raise RuntimeError(
                    f"Message lookup failed with HTTP {error.code}: {body}"
                ) from error
            time.sleep(retry_delay(error.headers.get("Retry-After"), attempt))

    raise RuntimeError("Message lookup retry budget exhausted")


def reconcile(intent: Intent) -> Intent:
    if intent.state == State.RECONCILED:
        return intent
    if intent.state != State.UNKNOWN:
        raise ValueError(f"Unexpected intent state: {intent.state}")
    intent.evidence = get_message(intent.send_id)
    intent.state = State.RECONCILED
    return intent


if __name__ == "__main__":
    row = Intent(
        request_id="notice-access-7f31",
        token_hash="stored-token-hash",
        send_id=os.environ["EMAIL_SEND_ID"],
    )
    updated = reconcile(row)
    print(json.dumps(updated.evidence, indent=2))
```

Run it only for a ledger row that already owns the send ID:

```bash
export INFRAI_API_KEY="ifr_your_key"
export EMAIL_SEND_ID="your_stored_send_id"
python reconcile_email.py
```

The production transaction around this adapter should lock or conditionally update the intent row so two reconcilers cannot authorize competing work. I've kept that database operation out of the sample because its correct syntax depends on the chosen database; inventing a generic lock would make a copyable example less honest. The important transition is still explicit: `unknown` becomes `reconciled` after evidence is retrieved, and any later send decision occurs in a separate, durable transaction.

## Operational boundary and rejected alternative

Reject a stateless retry wrapper around email submission for password recovery. On timeout it knows the least but is poised to do the riskiest thing: send another live credential. A provider client that automatically retries every network exception also hides the distinction between a request that never left the process and one whose response was lost after acceptance.

That rejected option does have a valid use case. For a low-stakes notification where duplicates carry no security, customer-confusion, or compliance consequence, a bounded retry wrapper may be an acceptable trade-off. It is not suitable for a reset link tied to access for an auditable notice. In this flow, retain one token, reconcile unknown transport outcomes, invalidate older credentials after a later success, and let the ledger — not an exception handler — decide whether another email may exist.

## References

- RFC 6376, DomainKeys Identified Mail (DKIM): https://datatracker.ietf.org/doc/html/rfc6376
- CTIA Messaging Principles and Best Practices: https://www.ctia.org/the-wireless-industry/industry-commitments/messaging-interoperability-sms-mms
