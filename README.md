# Pusher 🔴

[![Build and Publish Container to GHCR](https://github.com/erikmartino/pusher/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/erikmartino/pusher/actions/workflows/docker-publish.yml)
[![GitHub Container Registry](https://img.shields.io/badge/GHCR-ghcr.io%2Ferikmartino%2Fpusher-blue?logo=docker)](https://github.com/erikmartino/pusher/pkgs/container/pusher)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A tactile, responsive, installable Progressive Web App (PWA) push button built with vanilla web technologies and containerized with a zero-dependency Node.js Alpine server supporting native Web Push notifications.

---

## ✨ Features

- 🔘 **Tactile 3D Button**: Realistic multi-layer CSS bevels, drop shadows, and spring press animations.
- 📱 **Progressive Web App (PWA)**: Full offline support via custom Service Worker (`sw.js`), web app manifest, and icons for iOS, Android, and Windows tiles.
- 🔔 **Native Web Push**: Zero-dependency Web Push implementation (RFC 8291 / RFC 8292 VAPID) using built-in Node.js crypto.
- 🔊 **Web Audio Effects**: Procedurally synthesized mechanical click feedback.
- 📳 **Haptic Feedback**: Vibration API triggers on mobile devices when pressed.
- 📊 **Local Statistics**: Persistent click counters, combo streaks, and session metrics.
- 🐳 **Lightweight Container**: Zero-dependency Node.js Alpine image with static asset serving and push endpoints.
- 🚀 **Automated CI/CD**: Multi-platform container builds (`linux/amd64`, `linux/arm64`) pushed automatically to GitHub Container Registry (`ghcr.io`).

---

## 🚀 Quick Start with Container (Docker / Podman)

### Run from GitHub Container Registry

```bash
# Using Docker
docker run -d --name pusher -p 8080:80 ghcr.io/erikmartino/pusher:latest

# Using Podman
podman run -d --name pusher -p 8080:80 ghcr.io/erikmartino/pusher:latest
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

# Run local build
podman run --rm -p 8080:80 --name pusher pusher:latest
```

---

## 📦 Container Registry

The container image is published to GitHub Container Registry:
- **Registry**: `ghcr.io`
- **Image**: `ghcr.io/erikmartino/pusher`
- **Tags**: `latest`, `<git-sha>`, `vX.Y.Z`

---

## 📄 License

[MIT](LICENSE)
