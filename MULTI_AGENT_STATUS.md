# MergeConflicts rental multi-agent draft

Talkdesk orchestration: `Rental_MultiAgent_MergeConflicts` (draft V1). It is separate from the published rental demo and is not connected to its phone line.

The supervisor delegates through a Conditions node to five specialists:

- `Listing_Search_MergeConflicts`: MCP `listings`, currently mapped to search and locality.
- `Locality_Research_MergeConflicts`: MCP `research`, currently mapped to locality research and the shared locality variable.
- `Tenant_Memory_MergeConflicts`: MCP `tenant`, currently mapped to profile lookup by Caller ID.
- `Visit_Coordinator_MergeConflicts`: MCP `visits`, with schedule selected; required call inputs and outbound flows are not yet configured.
- `Deal_Advisor_MergeConflicts`: MCP `deal`, with update selected; required deal inputs are not yet configured.

On 2026-11-04, a simulator request for Whitefield safety and amenities produced a Talkdesk work-stream trace: supervisor -> locality researcher (`research` tool) -> supervisor. The response summarized findings but omitted the requested source links, so the response is not ready for publication.

Remaining before publishing: map bedroom, budget, deposit and amenity inputs for search; map memory updates, property events and call summaries; map visit and deal inputs; test each delegation and source citations; configure and test separate outbound call flows and notification delivery; add appropriate caller authentication. Caller ID by itself is not authentication. Do not claim that calls, visits, messages or signed agreements occurred based on dry runs.

The MCP server has a shared demo bearer token and is not a production tenant-isolation mechanism. It stores summaries and property events when a client explicitly invokes the memory actions. Full transcript backup, guaranteed end-of-call summaries, cross-provider listing deduplication, and WhatsApp/SMS are not implemented.
