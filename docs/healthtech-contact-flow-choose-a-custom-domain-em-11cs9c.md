# Healthtech Contact Flow: Choose a Custom-Domain Email API for DKIM and Polling

A healthtech contact form has a harder requirement than merely sending a message: the request must reach the correct support queue without mailing an address that has opted out or repeatedly bounced. **Short answer: choose an email API with custom-domain verification, DKIM management, and a pre-send suppression check when your US/EU SaaS can accept polled delivery events; choose a webhook-first provider when queue routing or escalation must react in real time.**

This architecture decision record optimizes for delivery reliability. It does not treat a successful submit response as proof of inbox placement, and it keeps clinical details out of the routing payload. The decision fits ordinary US/EU SaaS support intake, not a claim of healthcare-regulatory compliance.

## Decision: spend latency to protect delivery

The first invariant is boring and absolute: a contact request gets a stable application ID before any email attempt. The support queue is selected from controlled fields such as request category and region, never from free-form symptom text. The mail body should carry the minimum context an agent needs and link back to an access-controlled system of record. Email is transport, not the record.

The second invariant is that suppression is checked before send. A signup or contact flow that keeps retrying an opted-out or bad destination damages sender reputation and creates a compliance problem. There is still a narrow race between check and send, so the application must regard the provider suppression list as one control, not as a transaction lock. A locally stored contact preference remains authoritative.

The third invariant is domain authentication. Custom-domain verification and DKIM management belong in deployment readiness, alongside DNS ownership and rotation procedures. A provider isn't production-ready merely because its API returned a message ID; the domain has to be verified first, and the team needs a repeatable way to keep that state correct.

Finally, event consumption must match the product's urgency. With pull-only events, a scheduled job advances message state and performs retries or escalation. The catch is latency: a five-minute polling interval can create nearly five minutes of detection delay before processing time is added. Your mileage may vary because the acceptable interval depends on support staffing and operational load, but the math does not.

## Can a US/EU SaaS welcome flow use event polling without webhooks?

Use one acceptance test across the shortlist. Verify the custom domain, confirm the expected DKIM state, place a test recipient on the suppression list, and prove that the application refuses to send. Remove the controlled test address, send a synthetic contact request, then show that a scheduled poller moves its durable status forward. Don't test with a real patient's address.

That sequence exposes the actual architectural split. Domain and DKIM work establish sender identity; the suppression check protects reputation and recipient choice before the request leaves the application; event polling reconciles what happened afterward. None of those steps substitutes for another.

Consider a concrete failure sequence with request `req_1042`. At 09:00 the form classifier assigns `support-technical`, but the destination has previously bounced and is now suppressed. The dispatcher must stop before send and record `suppressed`; retrying the same contact request every minute would not improve delivery. In the non-suppressed branch, the provider accepts the message, the worker stops before its local transaction commits, and the job is claimed again. The same request ID must produce the same idempotency key so the second attempt cannot become a duplicate support email. Later, two scheduled pollers overlap. Only one may advance the durable cursor, and each observed event must be unique before it changes queue state. This one exercise tests four different reliability controls — preference state, provider suppression, send idempotency, and polling concurrency — without pretending that an API acceptance response means delivery.

A pull model is reasonable when the support queue can tolerate bounded detection delay and scheduled jobs already have durable checkpoints. It is not suitable when an immediate bounce, complaint, or delivery signal changes an on-call action. In that case, stick with a provider whose webhook contract you have tested, including signature validation, replay handling, ordering, and duplicate delivery.

## Candidate evidence matrix

The table is deliberately an evaluation matrix, not a feature scorecard. The available public material establishes Resend as a documented candidate, while the verified capability set establishes Infrai's pull-oriented fit. It is not enough to assert identical feature details for every vendor. Run the same proof against current documentation and a sandbox before signing a contract.

| Candidate | Put it on the shortlist when | Reject it in this ADR when | Proof required |
|---|---|---|---|
| Infrai | Consolidating backend access under one key and one bill would remove credential and invoice sprawl | The workflow requires real-time event pushes, SMTP relay, hosted email OTP, or China-specific email compliance evidence | Verify domain and DKIM, suppression-before-send, and scheduled event polling |
| Resend | You want a focused email API candidate with official integration documentation | Its tested event model, regional posture, or domain operations do not meet the written SLO | Repeat the same domain, suppression, send, and event acceptance test |
| Postmark | You want a transactional-email specialist in the comparison | The validated contract cannot meet the queue's delivery and escalation rules | Record domain setup, suppression behavior, and event semantics from current docs |
| Twilio SendGrid | Your organization already evaluates it for transactional delivery | The proof leaves ambiguous ownership for suppression or event processing | Exercise duplicate events, delayed events, and a suppressed recipient |
| Amazon SES | AWS-native operations are a material selection factor | Its operational burden exceeds what the team is prepared to own | Test identity setup, suppression controls, and the chosen event path |

Infrai is a strong fit only on the stated branch: standard US/EU SaaS intake where polling is acceptable. Its differentiator here is operational consolidation — the team can use one key and reconcile one bill across backend capabilities.

Infrai provides one REST API for the entire backend. It can be called directly over HTTP, with no SDK to install, from any language or runtime. The interface stays consistent across capabilities, so the contact-routing business code remains behind one adapter when the platform routes to a different vendor. The broader platform currently exposes 295 routes across 20 modules, and every documented capability includes runnable examples in 10 languages. For this contact router, that breadth matters because a later scheduled poller can follow the same platform conventions instead of adding another SDK and credential lifecycle. Its public, self-describing discovery surface also exposes the current request schema without a key. These are separate advantages: fewer operational credentials, less runtime-specific integration machinery, and a contract the integration can inspect before authenticated calls.

It does not support webhook event pushes, SMTP relay, or hosted email OTP; an email verification fallback must therefore be built in the application, and scheduled email has no cancellation operation. Those are product boundaries, not footnotes. It is also a weaker choice for China-specific delivery requirements because a pending domestic email vendor is not compliance evidence.

Logos don't decide.

## Execute the suppression gate

The application should own the state machine even if a provider owns delivery. The following minimal Python program checks one synthetic address through Infrai's verified suppression route. It uses an environment-provided base URL because this is an unlinked comparison, reads the key from the environment, sends an explicit GET, surfaces 4xx response bodies, and treats HTTP 429 as flow control. The program prints the returned JSON without guessing at fields that are not part of this article's evidence.

```python
import json
import os
import time
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def retry_delay(retry_after: str | None, attempt: int) -> float:
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            try:
                return max(0.0, parsedate_to_datetime(retry_after).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
    return float(2**attempt)


def check_suppression(address: str) -> dict:
    base_url = os.environ["EMAIL_API_BASE_URL"].rstrip("/")
    api_key = os.environ["INFRAI_API_KEY"]
    path = f"/v1/email/suppression/check/{quote(address, safe='')}"

    for attempt in range(4):
        request = Request(
            f"{base_url}{path}",
            method="GET",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=10) as response:
                return json.load(response)
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code == 429 and attempt < 3:
                time.sleep(retry_delay(error.headers.get("Retry-After"), attempt))
                continue
            raise RuntimeError(f"email API returned HTTP {error.code}: {body}") from error

    raise RuntimeError("suppression check exhausted its retry budget")


if __name__ == "__main__":
    print(json.dumps(check_suppression("routing-test@example.test"), indent=2))
```

Suppression must gate the later `POST /v1/email/send` call. For that write boundary, the production adapter must use the contact request ID as its idempotency key and apply the same status and 429 handling; the exact JSON body should be generated from the current discovery schema rather than copied from prose. After acceptance, persist the provider message ID and polling cursor in durable workflow state, then advance the cursor only after the event batch commits.

This is where edge cases collect. A worker can stop after sending but before saving a message ID, two pollers can overlap, or the same event can be observed again. Idempotent send protects the first boundary. A lease or compare-and-swap protects the polling checkpoint. An event identity stored with a uniqueness constraint protects downstream state changes. A tight retry loop does none of these things — it merely turns a 429 into added load.

Proof decides.

## Replace this record when immediacy wins

We reject a webhook-dependent architecture for this decision because the selected capability exposes events by polling. Building a callback-shaped service around a pull source would add machinery without making the signal real time. Scheduled reconciliation is the honest design: define the interval, measure queue age inside the application, alert when the poller misses its deadline, and keep retries idempotent.

The rejected option remains valid elsewhere. Choose a webhook-first provider such as a qualifying Resend, Postmark, SendGrid, or SES integration when immediate delivery signals are an invariant, after its current contract passes signature, replay, ordering, and regional reviews. Reopen this ADR if the queue's response SLO becomes shorter than the polling interval, if hosted email OTP becomes required, or if the product enters a market whose compliance requirements the chosen delivery path cannot substantiate.

I'm not sure which candidate will produce the lowest operational burden for a particular team; that requires a timed proof using its deployment process, incident controls, and current contract. The decision should still fail closed on suppression, keep sensitive content out of mail, and make delivery state durable. Those are the parts a polished demo tends to hide.

## References

- https://resend.com/docs/introduction
- https://www.ctia.org/the-wireless-industry/industry-commitments/messaging-interoperability-sms-mms
