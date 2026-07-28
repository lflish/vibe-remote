.PHONY: all server desktop clean dev-server dev-desktop portal dev-portal

# Default: build both
all: server desktop

# --- Server (Go) ---

server:
	cd vibe-remoted && go build -o ../bin/vibe-remoted ./cmd/vibe-remoted

dev-server:
	cd vibe-remoted && go run ./cmd/vibe-remoted --config ../vibe-remoted.json

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

# --- Web portal (Go static server hosting the web/ SPA) ---

portal:
	cd web && npm run build
	@rm -rf vibe-remoted/cmd/vibe-portal/dist
	@cp -R web/dist vibe-remoted/cmd/vibe-portal/dist
	cd vibe-remoted && go build -o ../bin/vibe-portal ./cmd/vibe-portal

dev-portal:
	cd web && npm run dev
