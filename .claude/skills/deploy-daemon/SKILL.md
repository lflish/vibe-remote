---
name: deploy-daemon
description: Cross-compile vibe-remoted and replace the binary on a remote Linux host over SSH, restart its systemd user service, and verify /healthz, /api/v1/info and /api/v1/sessions. Usage — /deploy-daemon <ssh-host> [daemon-addr:port]
disable-model-invocation: true
---

# deploy-daemon

Changes a live machine, so it only runs when the user invokes it. Desktop and
daemon must stay protocol-compatible; restarting an old binary does not pick up
protocol changes — the binary has to be replaced.

Arguments: `$ARGUMENTS` = `<ssh-host> [daemon-addr:port]`. If the daemon address
is omitted, ask for it: behind VM/NAT setups the SSH host and the daemon's
listen address differ, and the desktop needs the latter.

## Steps

1. **Gate**: `make check-server`. Stop on failure.
2. **Detect arch** and build a matching static binary:
   ```bash
   ARCH=$(ssh "$HOST" uname -m)          # x86_64 → amd64, aarch64 → arm64
   VERSION=$(git describe --tags --always --dirty)
   (cd vibe-remoted && CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH \
     go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /tmp/vibe-remoted.new ./cmd/vibe-remoted)
   ```
3. **Inspect before replacing**: `ssh "$HOST" 'systemctl --user cat vibe-remoted.service; command -v vibe-remoted; ls -l ~/.local/bin/vibe-remoted ~/vibe-remoted 2>/dev/null'`.
   Use the `ExecStart` path from the unit. If there is no unit, or it lacks
   `KillMode=process`, stop and tell the user: restarting would kill every live
   tmux session. Point them at `docs/deploy/vibe-remoted.service`.
4. **Replace and restart** (atomic install, old binary kept for rollback):
   ```bash
   scp /tmp/vibe-remoted.new "$HOST":/tmp/vibe-remoted.new
   ssh "$HOST" "cp -p '$BIN' '$BIN.prev' 2>/dev/null; install -m 0755 /tmp/vibe-remoted.new '$BIN' && rm /tmp/vibe-remoted.new && systemctl --user restart vibe-remoted.service"
   ```
5. **Verify** from this Mac against the daemon address. Read the token from the
   user's desktop `machines.json` entry or ask for it; **never echo it**:
   ```bash
   curl -sf "http://$ADDR/healthz"
   curl -sf -H "Authorization: Bearer $TOKEN" "http://$ADDR/api/v1/info"      # version must equal $VERSION
   curl -sf -H "Authorization: Bearer $TOKEN" "http://$ADDR/api/v1/sessions"  # existing sessions must still be listed
   ```
   On failure show `ssh "$HOST" journalctl --user -u vibe-remoted -n 50` and
   offer rollback (`mv "$BIN.prev" "$BIN" && systemctl --user restart vibe-remoted`).

Report the deployed version, the three endpoint results, and whether the
pre-existing sessions survived the restart.
