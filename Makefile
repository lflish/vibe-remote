.PHONY: all server desktop clean dev-server dev-desktop dev-local install-desktop \
	check check-server check-desktop dist-daemon smoke fmt vet

# Version stamped into the daemon (`vibe-remoted --version`, /api/v1/info).
# Release CI overrides this with the tag; local builds describe the checkout.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GO_LDFLAGS := -s -w -X main.version=$(VERSION)

# Default: build both
all: server desktop

# --- Checks ---
# `make check` is the single source of truth for "is this change OK": CI,
# CONTRIBUTING, the release checklist and the project `check` skill all call it
# instead of keeping their own command lists.

check: check-server check-desktop

check-server:
	@cd vibe-remoted && unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi
	cd vibe-remoted && go vet ./...
	cd vibe-remoted && go test -race -count=1 ./...

check-desktop:
	cd desktop && npm run typecheck
	cd desktop && npm test

# --- Server (Go) ---

server:
	cd vibe-remoted && go build -ldflags "$(GO_LDFLAGS)" -o ../bin/vibe-remoted ./cmd/vibe-remoted

# Cross-compiled daemon binaries for releases (the remote host usually has no Go).
DIST_PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

dist-daemon:
	@mkdir -p dist
	@for p in $(DIST_PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; \
		out=dist/vibe-remoted-$(VERSION)-$$os-$$arch; \
		echo "==> $$out"; \
		(cd vibe-remoted && CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -trimpath -ldflags "$(GO_LDFLAGS)" -o ../$$out ./cmd/vibe-remoted) || exit 1; \
	done

dev-server:
	cd vibe-remoted && go run ./cmd/vibe-remoted --config ../vibe-remoted.local.json

# Self-test on this machine: bind THIS host's tailscale IP (no insecure hatch),
# run tmux + real claude. Use for local end-to-end verification when you have
# no remote box — the desktop client points at the printed tailscale IP:port.
dev-local:
	@TS_IP=$$(tailscale ip -4 2>/dev/null | head -1); \
	if [ -z "$$TS_IP" ]; then \
		echo "ERROR: no tailscale IPv4 address (run 'tailscale up' first)"; exit 1; \
	fi; \
	VIBE_DEV_TOKEN=$$(openssl rand -hex 32); \
	echo "==> vibe-remoted self-test on $$TS_IP:8765"; \
	echo "==> one-time token: $$VIBE_DEV_TOKEN"; \
	echo "==> add this machine in the desktop client: addr=$$TS_IP port=8765"; \
	cd vibe-remoted && VIBE_REMOTED_BIND_ADDR=$$TS_IP VIBE_REMOTED_TOKEN=$$VIBE_DEV_TOKEN go run ./cmd/vibe-remoted --config ../vibe-remoted.local-tmux.json

# --- Desktop (Electron) ---

desktop:
	cd desktop && npm run build

dev-desktop:
	cd desktop && npm run dev

install-desktop:
	cd desktop && npm ci

# --- Utilities ---

clean:
	rm -rf bin/ dist/ desktop/dist/ desktop/release/

# Quick smoke test: check server healthz
smoke:
	@echo "Testing healthz..."
	@curl -sf http://localhost:8765/healthz && echo " OK" || echo " FAILED"

# Format
fmt:
	cd vibe-remoted && go fmt ./...

# Vet
vet:
	cd vibe-remoted && go vet ./...
