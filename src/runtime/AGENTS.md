# Isolated app-server adapter

Own model/effort configuration, executable resolution and identity pinning, ephemeral child environment, managed-auth symlink, bounded app-server protocol, and cleanup. Depend only on runtime files and Node built-ins. Keep no-tools permissions, disabled network/features, environment allowlist, response model/profile verification, and fail-closed item validation. Importing must have no child or filesystem side effects. Never execute proposed action metadata or open auth.json.

Validation: transport-runtime tests and syntax checks; no live child reviewer in tests.
