# Deterministic authorization policy

Own lexical command signals, explicit and learned-approval eligibility, and safe-read verification. Depend only on action contracts/utilities, shared config, and Node built-ins. Never turn a model rejection into allow. Verify actual regular-file identity, no-follow descriptors, and trusted server roots. A missing command signal never authorizes an action. Keep non-overridable policy separate from signals that only suppress learned approval; the latter must leave fresh exact human review available. The lexical detector is conservative and cannot interpret arbitrary shell or SQL. Preserve command boundary, flag-order, wrapper, nested-string, and SQL regressions. No child spawning or approval-state writes.

Validation: command-signal, review-policy, and filesystem tests.
