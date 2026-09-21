# Security policy

## Reporting a vulnerability

Please report security problems privately by email to holden@ssalomon.com
rather than in a public issue. Include what you found, how to reproduce it, and
the version or commit you tested. You should get a reply within a week.

## Scope

The parts most worth a look:

- **Profile egress boundaries.** A session on a LAN-only or offline profile
  must never be routed to a cloud model, directly or through a fallback rung or
  a machine-dispatched lane (compaction, the command classifier). A way around
  that is a vulnerability.
- **Offline profiles.** Shell commands run in a bubblewrap sandbox without
  network access, and web and MCP tools are refused. An escape counts.
- **The gateway.** It fronts paid subscriptions and reads provider keys from
  opencode's `auth.json`. Authentication bypasses, key disclosure in logs or
  responses, and ways to reach a provider the configuration does not list are
  in scope.
- **Admission.** A cloud provider must prove an OAuth login or be listed in
  `trustedSubscriptionProviders` before the broker leases it.

The broker listens only on a unix socket in a 0700 directory, and treats every
local process that can reach that socket as trusted.
