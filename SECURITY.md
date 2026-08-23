# Security policy

## Supported versions

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting option in the repository Security tab when it is available. If it is unavailable, open a minimal issue asking the maintainer for a private contact channel. Do not include credentials, exploit details, personal paths, session data, or other sensitive material in a public issue.

Please include the affected version, impact, reproduction conditions, and a suggested mitigation if known. You should receive an acknowledgement within seven days.

## Scope

Reports about credential exposure, unsafe model-routing behavior, untrusted catalog data, installer path handling, or cross-session data leakage are especially useful. Vulnerabilities in DeepSeek Harness, OpenCode, or an upstream model provider should also be reported to the relevant upstream project.

## LAN remote threat model

- The upstream DSH server always remains on loopback.
- The gateway listens only on loopback and private addresses carrying a Windows default route; it never listens on a wildcard public interface.
- LAN clients must exchange a short-lived signed pairing link for an HttpOnly, SameSite session. Pairing failures are throttled and WebSocket upgrades use the same authentication and origin checks.
- Authorized-device records contain random IDs only. Credentials, prompts, and session data are not copied into gateway storage.
- The zero-setup default is HTTP and is intended for a trusted private LAN. It does not defend against an attacker already able to sniff or alter that LAN. Do not expose port `3443` through router forwarding and do not use the gateway on public Wi-Fi.

The vendored `dsh-conversation-rewind` source is pinned to upstream commit `1414322a483d40cf83539f8badc59a93b05d0c77` under its MIT license. It was reviewed for subprocess, filesystem mutation, credential, and outbound-network access; none is present. Its production dependency audit reported zero known vulnerabilities at integration time.
