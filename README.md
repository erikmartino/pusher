# Pusher 🔴

[![Build and Publish Container to GHCR](https://github.com/erikmartino/pusher/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/erikmartino/pusher/actions/workflows/docker-publish.yml)
[![GitHub Container Registry](https://img.shields.io/badge/GHCR-ghcr.io%2Ferikmartino%2Fpusher-blue?logo=docker)](https://github.com/erikmartino/pusher/pkgs/container/pusher)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A tactile, responsive, installable Progressive Web App (PWA) push button built with vanilla web technologies and containerized with a zero-dependency Node.js Alpine server supporting native Web Push notifications.

---

## ✨ Features

- 🔘 **Tactile 3D Button**: Realistic multi-layer CSS bevels, drop shadows, and spring press animations.
- 📱 **Progressive Web App (PWA)**: Full offline support via custom Service Worker (`sw.js`), web app manifest, and icons for iOS, Android, and Windows tiles.
- 🔔 **Native Web Push**: Zero-dependency Web Push implementation (RFC 8291 / RFC 8292 VAPID) using built-in Node.js crypto.
- 🔊 **Web Audio Effects**: Procedurally synthesized mechanical click feedback.
- 📳 **Haptic Feedback**: Vibration API triggers on mobile devices when pressed.
- 📊 **Local Statistics**: Persistent click counters, combo streaks, and session metrics.
- 🤖 **WebMCP (Web Model Context Protocol)**: Native AI agent tool integration via declarative HTML forms and imperative `document.modelContext` with `/.well-known/webmcp.json` discovery.
- 🐳 **Lightweight Container**: Zero-dependency Node.js Alpine image with static asset serving and push endpoints.
- 🚀 **Automated CI/CD**: Multi-platform container builds (`linux/amd64`, `linux/arm64`) pushed automatically to GitHub Container Registry (`ghcr.io`).

---

## 🚀 Quick Start with Container (Docker / Podman)

### Run from GitHub Container Registry

```bash
# Using Docker
docker run -d --name pusher -p 8080:80 -v pusher_data:/data ghcr.io/erikmartino/pusher:latest

# Using Podman
podman run -d --name pusher -p 8080:80 -v pusher_data:/data ghcr.io/erikmartino/pusher:latest
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

---

## 🛠️ Local Development

### Prerequisites
- Node.js & pnpm (or npm / npx)
- Podman or Docker

### Running Locally

```bash
# Clone the repository
git clone https://github.com/erikmartino/pusher.git
cd pusher

# Start local development server
pnpm dev
# or
npx serve . -l 3000
```

### Build Container Locally

```bash
# Using Docker
docker build -t pusher:latest .

# Using Podman
podman build -t pusher:latest .

# Run local build with persistent storage
podman run --rm -p 8080:80 -v pusher_data:/data --name pusher pusher:latest
```

---

## 📦 Container Registry

The container image is published to GitHub Container Registry:
- **Registry**: `ghcr.io`
- **Image**: `ghcr.io/erikmartino/pusher`
- **Tags**: `latest`, `<git-sha>`, `vX.Y.Z`

---

## 🤖 WebMCP (Web Model Context Protocol)

Pusher supports [WebMCP](https://webmachinelearning.github.io/webmcp/), allowing AI browser agents to discover and interact with the push button directly via structured tools without brittle DOM scraping:

- **Discovery**: Machine-readable catalog available at `/.well-known/webmcp.json` and announced via `<link rel="webmcp" href="/.well-known/webmcp.json" />` and `Link: </.well-known/webmcp.json>; rel="webmcp"` HTTP header.
- **Declarative WebMCP**: Annotated HTML `<form toolname="..." tooldescription="..." toolautosubmit>` elements with `toolparamdescription` fields.
- **Native Imperative WebMCP**: Automatic registration via `document.modelContext.registerTool()` (and `navigator.modelContext`) without third-party polyfills.
- **Exposed Tools**:
  - `push_button`: Presses the tactile button (`count` parameter 1-100).
  - `get_status`: Inspects button state, push count, rate, sound, and online sync status.
  - `reset_counter`: Resets push counter to 0.
  - `set_sound`: Enables or mutes tactile mechanical audio feedback (`enabled: boolean`).

---

## 📄 License

[GNU General Public License v3.0 (GPL-3.0)](LICENSE)
