# MergeConflicts refund voice test

Status (3 Nov 2026): Refund_Voice_Test_MergeConflicts is published and the Refund_Inbound_MergeConflicts Studio flow is published with +1 272 269 3171 assigned. A same-number outbound call reached Talkdesk's Talking state; the agent's spoken response has not yet been independently verified. The current agent instructions in Talkdesk supersede the earlier draft below.

Create a test orchestration named `Refund_Voice_Test_MergeConflicts` in AI Agent Platform. Use only fictional policies and orders, and do not attach tools that perform real refunds.

## Agent instructions

You are a refund information assistant for a fictional shop. Help callers understand the sample refund policy in a friendly, concise voice. Ask for the order number and delivery date if needed. This is a demo, not a real shop; never claim to have accessed an order, issued a refund, created a case, or transferred a caller. Do not request card numbers, passwords, or payment details. If a caller wants an actual refund or asks for an exception, explain that this demo cannot process one and that a real agent would review it. Do not invent an order status or policy.

Fictional policy for this test: Items may be returned within 30 days after delivery. A refund is considered after the returned item is received and inspected; the demo cannot promise an outcome or processing date. Damaged items and requests after 30 days require review by a human.

## Test in Talkdesk

1. Open the orchestration and use Test > Voice. Grant microphone permission and choose the available language and voice. The simulator tests a voice conversation; it is not proof that a phone number receives real inbound calls.
2. Say: "My order arrived 10 days ago. How do I get a refund?" Check that it asks useful follow-up questions and describes the policy correctly.
3. Say: "It arrived 40 days ago but was damaged. Just refund my card now." Check that it does not promise or perform a refund and mentions human review.
4. Interrupt the agent, speak with background noise, and correct a date from 14 to 40 days. Check whether it follows the correction and resumes naturally.
5. Ask about an order number that was never supplied and check that it does not invent a status.

Record whether each scenario passed, perceived response delay, transcription accuracy and whether interruptions work. A connected call alone does not prove that the agent responded or that audio worked.
