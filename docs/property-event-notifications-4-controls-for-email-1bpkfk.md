# Property Event Notifications: 4 Controls for Email and SMS API Delivery

Short answer: For a property-management contact form, own the queue-routing template in the application, treat email and SMS submission as asynchronous work, and poll delivery status with bounded exponential backoff that honors `429` responses. Keep status transitions and correlation IDs; stop retaining rendered message bodies once the support and compliance window closes.

The bill is made of more than sends. Model it as `submission attempts + delivery-status checks + retained bytes + operator time`, using the actual unit rates from the providers under evaluation. Then count each term in production. If 100,000 event notifications trigger ten status checks apiece, polling creates 1,000,000 checks; reaching a terminal state in an average of three checks lowers that modeled workload to 300,000. That 700,000-check difference is arithmetic, not a promised saving: its financial effect depends on the contract, while its capacity effect is immediate.

This points to the least complex design that works: one durable notification record, one worker per channel, and one scheduled status checker. Don't hold a web request open while a leasing question works its way to a regional support queue.

## Migration starts with a durable property event identity

A contact form event should first become a small, durable record. Give it an internal event ID, property ID, destination queue, template version, channel, provider correlation ID, current delivery state, attempt count, and the next eligible check time. The form handler can acknowledge receipt after that record is committed; delivery workers do the network work outside the request path.

Three counters reveal where the operational cost actually sits: submissions by channel and result, status checks by result, and retained bytes by data class. A fourth measure, queue age, catches the case that accounting misses. A cheap request that waits forty minutes is still a bad notification. Use a worked model before tuning. Suppose a routing rule emits one email to the property team and an SMS only for an urgent safety category. Count those as separate messages even though they share an event ID. If the email reaches a terminal state after two checks and the SMS after four, the event caused six checks, not three. This distinction matters when retrying: a retry of the failed SMS must not duplicate the delivered email. It also keeps the support trail legible when a resident submits the same form twice. Retention needs the same separation. Keep the event ID, template version, routing decision, timestamps, and normalized state for the audit period chosen by legal and operations. Protect recipient addresses and phone numbers according to their sensitivity. Retaining the fully rendered body can help investigate a disputed routing decision, but it also preserves free-form contact text that may contain access instructions, names, or other sensitive details. The deliberate trade is to delete that body when its defined support window ends. After deletion, an operator can prove which template and route were used, but may be unable to reconstruct every word that was sent.

That's the loss. Make it explicit.

## How should a Node.js event notification API poll email and SMS delivery status after 429?

The state machine should be independent of the runtime, even when the production worker is Node.js. The focused Python example below makes the control flow visible: the caller supplies the provider's documented status URL and terminal states, `429` delays the next check, successful nonterminal responses advance the backoff, and a deadline ends the job. A Node.js implementation should preserve those same boundaries in its HTTP client and job scheduler rather than hiding retries inside a generic request wrapper.

```python
import json
import random
import time
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen


@dataclass
class PollResult:
    state: str
    checks: int


def poll_delivery(
    status_url: str,
    auth_header: str,
    terminal_states: set[str],
    sleep: Callable[[float], None] = time.sleep,
    deadline_seconds: float = 900,
) -> PollResult:
    started = time.monotonic()
    delay = 2.0
    checks = 0

    while time.monotonic() - started < deadline_seconds:
        request = Request(
            status_url,
            headers={"Authorization": auth_header, "Accept": "application/json"},
            method="GET",
        )

        try:
            with urlopen(request, timeout=10) as response:
                payload = json.load(response)
                checks += 1
                state = str(payload["status"])
                if state in terminal_states:
                    return PollResult(state=state, checks=checks)
        except HTTPError as error:
            checks += 1
            if error.code != 429:
                raise

            retry_after = error.headers.get("Retry-After", "")
            if retry_after.isdigit():
                delay = max(delay, float(retry_after))

        jittered_delay = delay * random.uniform(0.8, 1.2)
        sleep(jittered_delay)
        delay = min(delay * 2, 120.0)

    raise TimeoutError("delivery status did not become terminal before the deadline")
```

The numbers in that example are policy inputs, not universal defaults. Ten seconds bounds an individual request, 900 seconds bounds the whole polling job, and 120 seconds caps a wait. Set them from the notification's urgency, the provider's published behavior, and measured delivery latency. I'm not sure a single deadline can serve both an urgent lockout message and a routine amenity notice; production traces would resolve that, and separate policies are usually easier to reason about.

Do not retry every failure. A rate limit response is a scheduling signal; malformed credentials or an invalid destination need a terminal operational state and review. Store `next_check_at` and release the worker instead of sleeping inside a scarce worker process. The sample sleeps only to expose the algorithm in one copyable block.

Idempotency sits one level above polling. Assign a stable notification ID before the first submission, persist the provider correlation ID from the accepted response, and ensure a restarted worker resumes status checks rather than submitting a new message. If the submission result is uncertain, reconcile it through the provider's documented mechanism before attempting another send. Otherwise, a network interruption between acceptance and local persistence can turn a retry policy into duplicate resident messages.

## Governance requires one owner for template releases

For this contact-form workflow, application-owned templates are the better default because the routing inputs and the message version can change atomically with code and tests. The application selects a versioned template from structured fields such as property, issue category, urgency, and locale; it does not splice the raw form body into a routing instruction. Channel adapters then render the approved email and SMS forms and submit them through generic interfaces.

The catch is operational ownership. Application-owned templates make copy changes wait for the software release process, and they require the engineering team to maintain localization, escaping, preview tests, and approval history. A provider-owned template can be more suitable when compliance or communications staff must change approved wording without a deployment. Stick with that model when non-engineers truly own the release workflow, but export or record a stable template identifier so an incident review can identify what was sent.

Email and SMS also have different constraints. Email authentication policy belongs to the sending domain, and DMARC provides the standards context for domain-based message authentication and reporting. SMS used as an authenticator has security and lifecycle concerns beyond ordinary support alerts; NIST's authenticator guidance is the relevant starting point. A property support notification should not quietly become an authentication design because both happen to use a phone number.

Keep queue selection out of prose templates. A routing function should return a queue ID and a reason code before rendering begins — for example, property plus issue category can choose the regional maintenance queue, while urgency decides whether an SMS companion is allowed. This makes the decision testable without sending anything and prevents a copy edit from changing operational routing.

## Why should a reliability drill include the wrong support queue?

A useful test matrix covers accepted submission, nonterminal delivery, terminal delivery, terminal failure, `429` with a valid delay, `429` without one, process restart, and deadline expiry. Also test two channels under one event: email may finish while SMS is still pending, and either state must survive a worker restart without resetting the other. The evidence ledger should make each diagnosis direct:

| Observed condition | Evidence to inspect | Next action |
| --- | --- | --- |
| Status checks keep returning a nonterminal state | Queue age, next check time, and check count | Continue only within the event deadline |
| A `429` delays checking | Recorded retry delay and attempt number | Reschedule without submitting the message again |
| Email is terminal while SMS is pending | Per-channel state under the same event ID | Advance only the unfinished channel |
| Delivery is terminal but the wrong team responds | Queue ID, routing reason, and template version | Correct and redeploy the routing decision |

Observability should follow the same state machine. Log internal event ID, channel, template version, attempt number, normalized status, provider correlation ID, and next action; exclude message bodies and authentication values. Alert on queue age and the share of records past their delivery deadline, not on every transient retry. Your mileage may vary on thresholds, so derive them from normal traffic by property and channel rather than copying a round number from an example.

## Roll out routing versions without duplicate notifications

Roll out routing and template changes with recorded fixtures from sanitized form categories. Shadow-evaluate the new routing function, compare its queue ID and reason code with the active version, then promote it independently from the channel adapters. This catches the dangerous class of change: delivery remains healthy, but the notification reaches the wrong property team.

This design is not suitable when the provider offers no queryable delivery state and no trustworthy correlation identifier. In that case, repeated polling cannot create certainty; choose a documented event callback if available, or narrow the product promise to submission status. The honest state may be `accepted`, not `delivered`.

## Further reading

- [RFC 7489: Domain-based Message Authentication, Reporting, and Conformance (DMARC)](https://datatracker.ietf.org/doc/html/rfc7489)
- [NIST SP 800-63B: Digital Identity Guidelines for Authentication and Lifecycle Management](https://pages.nist.gov/800-63-3/sp800-63b.html)
