import assert from "node:assert/strict";
import { shouldSendDeadlineFollowup } from "../src/matter-followup";
const base = { matterId: "MAT-1", recipient: "counsel@example.com", deadline: "2026-08-12", today: "2026-08-10" };
assert.equal(shouldSendDeadlineFollowup({ ...base, signedDocumentDelivered: true }), true);
assert.equal(shouldSendDeadlineFollowup({ ...base, signedDocumentDelivered: false }), false);
assert.equal(shouldSendDeadlineFollowup({ ...base, signedDocumentDelivered: true, deadline: "2026-08-20" }), false);
console.log("matter follow-up decision: passed");
