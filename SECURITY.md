# Security policy

## Supported versions

Security fixes target the current `main` branch. Once tagged releases exist,
fixes target current `main` and the newest published release.

## Report a vulnerability

Use GitHub private vulnerability reporting for this repository. Include the
affected version, a minimal reproduction, impact, and any suggested
mitigation. Do not put credentials, private data, or exploit details in a
public issue.

If private vulnerability reporting is not available, open a public issue that
contains no sensitive or exploit information and asks the maintainer to
establish a private contact channel. Do not test against systems or data you do
not own or have permission to use.

The HTTP adapter is intended for trusted local use. It does not provide
authentication, authorization, or TLS termination. Do not expose it directly
to an untrusted network; place an authenticated, rate-limited reverse proxy in
front of it when remote access is required.

The MCP stdio adapter bounds its inbound message buffer near the request
ceiling. An oversized inbound message deliberately closes the transport and
the server process exits, so the host restarts it into a clean state instead
of the server buffering, parsing, or multiplying the payload in memory.
In-limit requests never reach that path and are answered as structured errors
on the same connection.
