# MergeConflicts Rental Concierge

**Winner of the 2026 Talkdesk hackathon at PES University.**

MergeConflicts built a voice-based rental concierge to make finding a home in Bengaluru less time-consuming. A prospective tenant can describe what they need in a conversation, explore matching properties, and ask the assistant to coordinate a viewing or negotiate with an owner.

## How it works

1. **Discuss the search.** The tenant tells the concierge their preferred locality, number of bedrooms, budget and other requirements.
2. **Explore properties.** The assistant searches listings and web sources, describes options conversationally and helps the tenant consider a property or neighbourhood.
3. **Arrange a viewing.** A separate owner-facing voice agent calls to discuss the requested time. The concierge follows up with the tenant about the owner's response; a request is not a confirmed appointment until the owner agrees.
4. **Negotiate.** The tenant can specify a target and a private maximum. The owner-facing agent uses relevant market research to discuss an offer within those limits, then the tenant receives the outcome.
5. **Continue later.** The prototype stores preferences and structured information about properties, viewings and negotiations to give returning conversations context.

## Built with

- **Talkdesk Studio and AI Agent Platform** for call flows and conversational agents.
- **Cloudflare Workers and D1** for the MCP tools, call coordination and persistent demo data.
- **API.SH, Parallel and Firecrawl** for listing discovery and research.
- **ElevenLabs** for an experimental owner-negotiation voice integration.

## Prototype scope

This is a hackathon prototype, not a production rental service. The demo includes **MergeConflicts Garden Residences**, a fictional showcase property generated for the conversation; it is not a real listing or associated with a real developer. External listing information can be incomplete or change. Parts of the calling workflow use demo-specific routing, and caller authentication and general-purpose deployment need further work. The ElevenLabs bridge passed a simulated stream test; its use in a live outbound Talkdesk call still needs verification.

The Worker implementation is in [`rental-worker/`](rental-worker/), agent instructions are in [`talkdesk/`](talkdesk/), and development notes are in [`HANDOFF.md`](HANDOFF.md).
