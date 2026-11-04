# Talkdesk + Jev routing: investigation

Status: preliminary research, not an implemented or verified end-to-end integration.

## Intended flow

1. A Talkdesk Studio flow obtains a customer's request as text.
2. A custom integration calls a team-owned service which asks Jev to choose a predefined intent, including an unknown option.
3. Deterministic code maps permitted labels to team-owned queues; errors, timeouts, and uncertain or unknown cases go to a general queue.
4. The result is returned to Studio and an Assignment and Dial step routes the interaction.

This is a proposed design. Sandbox permissions, voice transcription, the external service connection, available queues, and the final route are not verified. Jev requires separate provider access. Use synthetic examples until data handling is agreed.

## OAuth investigation (2026-11-03)

- The local `.env` contains Talkdesk OAuth configuration and is ignored by Git. Do not print secrets or tokens.
- A `queues:read` token request returned HTTP 400 `invalid_scope`; queue inspection did not occur.
- A `data-tables:read` token was issued, but the export-jobs GET returned HTTP 401. The earlier Claude session showed that endpoint also needs `data-tables-exports:read`. With both scopes, the same read-only endpoint returned HTTP 200 on 2026-11-03. No response content was displayed. The endpoint is account-wide, so prefer team-specific resources for further inspection.
- Claude's 2026-11-02 session reported 281 configured scopes across AI, contacts, interactions, cases, data tables, selected flows, recordings, and integrations. Only the export endpoint was tested in that session; permissions elsewhere remain unverified. Queue and user administration were not added. A token with all scopes produced HTTP 400, so request only the scopes needed.
- `inspect_queues.py` performs a read-only, name-filtered query after requesting only `queues:read`.

## Sandbox boundaries

Name created resources with `MergeConflicts`; do not modify or delete other teams' resources. Avoid making changes to shared resources. A working Talkdesk integration is part of the hackathon; external services are allowed according to the pre-briefing notes.

## References

- https://docs.typesafe.ai/
- https://studio.talkdesk.com/docs/faqs
- https://studio.talkdesk.com/docs/using-data-from-external-apis-containing-arrays
- https://docs.talkdesk.com/docs/migrating-from-ring-groups-to-queues-api
- https://support.talkdesk.com/hc/en-us/articles/46063702440475-AI-Agent-Platform-Build-Skill-MCP
