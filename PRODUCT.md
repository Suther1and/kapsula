# Kapsula (Notes+) — Product Truth (`PRODUCT.md`)

**Kapsula** is a zero-friction, privacy-first Windows desktop personal memory companion (built on Electron, React, TypeScript, local SQLite FTS5, Windows DPAPI + AES-256-GCM encryption, and optional local/cloud AI enrichment).

## Core Surfaces
1. **Vault Workspace (`VaultSurface`):** The primary calm dark studio for organizing, browsing, editing, and querying saved memories — notes, OpenGraph links, screenshots with hidden searchable recognized text, Telegram «Избранное» posts with multi-block code snippets, voice/call recordings with AI digests & transcripts, PDF/DOCX documents, and encrypted secrets (bank cards, passwords, API keys).
2. **Floating Orb & Quick Pocket (`CapsuleSurface`):** Always-on-top compact 56×56 pearl sphere on the desktop edge. Draggable anywhere along screen edges; single click expands smoothly via continuous spring morph into Quick Pocket; drag-drop captures files, screenshots, links, or text without opening Vault. Hovering never opens Pocket uninvited.
3. **Spotlight HUD (`HudSurface`):** Global keyboard-first command bar (`Alt + Space` default, customizable in Settings) with instant local search, `Enter` copy, `Shift + Enter` Paste-Back directly into the previously focused application, clipboard capture, voice capture, and inline Vault unlock.

## Product Principles
- **Organic Cold Start:** Zero pre-seeded topic folders (`0 разделов`) and zero demo clutter for new vaults. Sections evolve around what the user actually saves; fleeting scratch noise stays unfoldered in `Все записи`.
- **Plain Human Russian (`на «ты»`):** Zero internal developer telemetry, model cost counters, or cryptographic acronyms in user-facing UI.
- **Zero-Lock-In Offline Integrity:** Local SQLite database, encrypted payloads, and thumbnails live locally on disk and remain instant offline.
