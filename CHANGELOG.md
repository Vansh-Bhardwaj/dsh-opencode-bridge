# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Added locally generated QR codes to the computer-only Remote Access page.
- Clarified the loopback DSH server and authenticated LAN gateway architecture in the pairing UI.
- Fixed repeated launcher installs nesting the gateway directory and hardened late upstream proxy failures.
- Replaced the desktop rail on phones with a touch-native sessions drawer, backdrop, app bar, and full-screen details treatment.
- Removed the Local Remote status pill and preserved DSH-owned cookies through the authenticated gateway.
- Disabled stale caching for the injected mobile shell assets so phone layout fixes apply immediately.
- Restored iPhone LAN sessions with an early secure `crypto.randomUUID` compatibility bootstrap.
- Reworked Settings into a full-screen, scroll-safe mobile layout with accessible horizontal sections.
- Reduced Remote Access to one canonical default-route URL and one locally generated QR code.
- Added a task-aware phone header, one-tap new sessions, reconnect feedback, swipe-to-close chats, keyboard-safe composition, and long-chat rendering containment.
- Expanded bounded retries to provider timeouts and capacity errors, repaired CRLF-only edit mismatches, and added precise diagnostics for duplicate and read-before-edit failures.

## 2.0.0 - 2026-08-23

- Added bounded automatic recovery for misclassified provider network failures.
- Added workspace-bound mutation guards, no-op edit recovery, and fresh excerpts after stale edit failures.
- Reduced visible vision-worker context while preserving model switching and automatic `read_image` delegation.
- Added append-only previous-message editing and branch browsing through an audited pinned plugin.
- Added an authenticated LAN-only reverse proxy with HTTP and WebSocket forwarding, persistent device pairing, private-route binding, and health checks.
- Added responsive mobile/PWA metadata and a dedicated Remote Access Start-menu shortcut.
- Aligned the tested Harness release to `0.1.1-rc.2`.

## 1.4.0 - 2026-08-21

- Added automatic OpenCode model and capability discovery.
- Added a full OpenCode Go usage dashboard.
- Added an integrated model, effort, and provider picker.
- Added automatic vision-worker delegation for text-only models.
- Preserved visual context when switching image conversations to text-only models.
- Preferred DeepSeek V4 Flash Vision Exp when available.
- Added an idempotent installer and optional direct-DeepSeek retention.
