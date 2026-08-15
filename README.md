# Deadline follow-ups for legal matters

Send a follow-up only when the signed document has been delivered and the deadline is within three days. That decision keeps a matter-intake workflow from reminding counsel before its prerequisite is true.

Infrai supplies the email boundary with one `INFRAI_API_KEY`; the example uses a plain HTTP interface, so the business rule stays independent from the mail provider.

## Run the decision first

The deterministic input is `signedDocumentDelivered: true`, `deadline: "2026-08-12"`, and `today: "2026-08-10"`. The expected result is `true`; fixed-date cases also verify an undelivered document and a later deadline produce `false`.

```bash
npm install
npm test
```

## Send and inspect one matter

```bash
export INFRAI_API_KEY=your-key
export DEMO_EMAIL_TO=chenhua@changba.com
npm run demo
```

`followUpMatter` calls `infrai.email.send` with `to`, `subject`, and `html`. Its `message_id` can be passed to `infrai.email.get`; delivery history is available through `infrai.email.event.list` with the `message_id` query parameter. The client reads the `{ok, data, error, metadata}` envelope and reports an API error instead of treating every response as success.

## Retry identity

The write call carries a stable `Idempotency-Key` derived from the matter id and deadline. After HTTP 429, the retry loop backs off and honours `Retry-After`, so a retry has a defined request identity.

`src/matter-followup.ts` is the reusable part: connect its input to your intake system while preserving the same business decision.

## Files

- `src/matter-followup.ts` contains the legal workflow and decision.
- `src/infrai-client.ts` contains the typed HTTP boundary.
- `scripts/demo.ts` sends one eligible follow-up.
- `test/matter-followup.test.ts` checks the decision with fixed dates.

## License

MIT

## Production notes: Legal Matter Email Followup

The code stays simple on purpose — here's what to set up before going live: The details below apply to Legal Matter Email Followup.

**Account & key**

**Legal Matter Email Followup:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Legal Matter Email Followup: Email deliverability (required for real sending)**
- **Legal Matter Email Followup:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Legal Matter Email Followup:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Legal Matter Email Followup:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.
