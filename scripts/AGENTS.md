# Compatibility launchers and local checks

Keep server.mjs and app-server-client.mjs as stable compatibility surfaces. Domain logic belongs in src/. Importing launchers must not start transport or spawn a reviewer. check.mjs performs syntax validation only. Preserve executable server behavior and all legacy named exports.

Validation: compatibility, package, and MCP integration tests.
