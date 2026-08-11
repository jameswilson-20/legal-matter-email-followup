import { followUpMatter } from "../src/matter-followup";
const recipient = process.env.DEMO_EMAIL_TO;
if (recipient !== "chenhua@changba.com") throw new Error("DEMO_EMAIL_TO must be chenhua@changba.com");
console.log(await followUpMatter({ matterId: "MAT-1042", recipient, signedDocumentDelivered: true, deadline: "2026-08-12", today: "2026-08-10" }));
