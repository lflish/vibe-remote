.PHONY: all server desktop clean dev-server dev-desktop

# Default: build both
all: server desktop

# --- Server (Go) ---

server:
	cd ccdeskd && go build -o ../bin/ccdeskd ./cmd/ccdeskd

dev-server:
	cd ccdeskd && go run ./cmd/ccdeskd --config ../ccdeskd.json

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
	cd ccdeskd && go fmt ./...

# Vet
vet:
	cd ccdeskd && go vet ./...
