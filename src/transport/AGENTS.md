# MCP JSON-RPC transport

Own bounded stdin framing, protocol negotiation, tool routing, cancellation, and shutdown. Depend only on action, review, config, and Node built-ins. Initialize before tool access; keep stdout exclusively JSON-RPC. Pass only signal/timeout controls to the service. Importing must not attach listeners or start serving; only main() starts transport.

Validation: transport-runtime integration and stream-bound tests.
