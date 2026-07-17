.PHONY: all server desktop clean dev-server dev-desktop dev-local

# Default: build both
all: server desktop

# --- Server (Go) ---

server:
	cd vibe-remoted && go build -o ../bin/vibe-remoted ./cmd/vibe-remoted

dev-server:
	cd vibe-remoted && go run ./cmd/vibe-remoted --config ../vibe-remoted.json

# Self-test on this machine: bind THIS host's tailscale IP (no insecure hatch),
# run tmux + real claude. Use for local end-to-end verification when you have
# no remote box — the desktop client points at the printed tailscale IP:port.
dev-local:
	@TS_IP=$$(tailscale ip -4 2>/dev/null | head -1); \
	if [ -z "$$TS_IP" ]; then \
		echo "ERROR: no tailscale IPv4 address (run 'tailscale up' first)"; exit 1; \
	fi; \
	echo "==> vibe-remoted self-test on $$TS_IP:8765 (token: local-selftest-token)"; \
	echo "==> add this machine in the desktop client: addr=$$TS_IP port=8765"; \
	cd vibe-remoted && VIBE_REMOTED_BIND_ADDR=$$TS_IP go run ./cmd/vibe-remoted --config ../vibe-remoted.local-tmux.json

# --- Desktop (Electron) ---

desktop:
	cd desktop && npm run build

dev-desktop:
	cd desktop && npm run dev

install-desktop:
	cd desktop && npm install

# --- Utilities ---

clean:
	rm -rf bin/ desktop/dist/

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
