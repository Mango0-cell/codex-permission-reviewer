# MCP JSON-RPC transport

Own bounded stdin framing, protocol negotiation, tool routing, cancellation, and shutdown. Depend only on action, review, config, and Node built-ins. Initialize before tool access; keep stdout exclusively JSON-RPC. Pass only signal/timeout controls to the service. Importing must not attach listeners or start serving; only main() starts transport.

Validation: transport-runtime integration and stream-bound tests.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
