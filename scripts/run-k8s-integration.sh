#!/usr/bin/env bash
# run-k8s-integration.sh
#
# Spins up a kind cluster, runs kubectl proxy for auth, runs
# the K8s integration tests, and tears everything down.
#
# Uses an isolated kubeconfig so it never touches your default
# ~/.kube/config or switches your active context.
#
# Usage:
#   ./scripts/run-k8s-integration.sh
#
# Env:
#   KEEP_CLUSTER=1   — skip teardown for debugging
#
# Prerequisites: docker, kind (installed automatically if missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

KIND_CLUSTER_NAME="blink-test"
K8S_DIR="$REPO_ROOT/packages/server/test/k8s"

# Temp files — cleaned up on exit.
KIND_KUBECONFIG="$(mktemp "${TMPDIR:-/tmp}/blink-kind-kubeconfig.XXXXXX")"
PROXY_KUBECONFIG="$(mktemp "${TMPDIR:-/tmp}/blink-proxy-kubeconfig.XXXXXX")"
PROXY_LOG="$(mktemp "${TMPDIR:-/tmp}/blink-kubectl-proxy.XXXXXX")"
PROXY_PID=""

# ---------------------------------------------------------------------------
# Install kind if it's not on PATH.
# ---------------------------------------------------------------------------
install_kind() {
  if command -v kind &>/dev/null; then
    echo "kind already installed: $(kind version)"
    return
  fi
  echo "Installing kind..."
  local arch os
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  curl -Lo /tmp/kind "https://kind.sigs.k8s.io/dl/v0.27.0/kind-${os}-${arch}"
  chmod +x /tmp/kind
  sudo mv /tmp/kind /usr/local/bin/kind 2>/dev/null || {
    mkdir -p "$HOME/.local/bin"
    mv /tmp/kind "$HOME/.local/bin/kind"
    export PATH="$HOME/.local/bin:$PATH"
  }
  echo "kind installed: $(kind version)"
}

# ---------------------------------------------------------------------------
# Cluster lifecycle.
# ---------------------------------------------------------------------------
create_cluster() {
  if kind get clusters 2>/dev/null | grep -q "^${KIND_CLUSTER_NAME}$"; then
    echo "Cluster ${KIND_CLUSTER_NAME} already exists, reusing."
  else
    echo "Creating kind cluster '${KIND_CLUSTER_NAME}'..."
    kind create cluster --config "$K8S_DIR/kind-config.yaml" --wait 60s
  fi
  kind get kubeconfig --name "${KIND_CLUSTER_NAME}" > "$KIND_KUBECONFIG"
}

delete_cluster() {
  echo "Deleting kind cluster '${KIND_CLUSTER_NAME}'..."
  kind delete cluster --name "${KIND_CLUSTER_NAME}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# kubectl proxy — provides an HTTP bridge that handles TLS and
# client-cert auth so the test can use plain HTTP. This works
# around bun's fetch ignoring the node-fetch agent option.
# ---------------------------------------------------------------------------
start_proxy() {
  echo "Starting kubectl proxy..."
  KUBECONFIG="$KIND_KUBECONFIG" kubectl proxy --port=0 --disable-filter=true >"$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  # Wait for the proxy to print its port.
  local attempts=0
  local proxy_port=""
  while [[ -z "$proxy_port" && $attempts -lt 30 ]]; do
    sleep 0.5
    # Extract the port from "Starting to serve on 127.0.0.1:<port>".
    # Use sed instead of grep -P for macOS compatibility.
    proxy_port=$(sed -n 's/.*Starting to serve on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$PROXY_LOG" 2>/dev/null || true)
    ((attempts++)) || true
  done

  if [[ -z "$proxy_port" ]]; then
    echo "ERROR: kubectl proxy failed to start" >&2
    cat "$PROXY_LOG" >&2
    exit 1
  fi

  echo "kubectl proxy running on port $proxy_port (PID $PROXY_PID)"

  # Write a minimal kubeconfig that points at the proxy (plain HTTP,
  # no TLS, no client certs — the proxy handles all of that).
  cat > "$PROXY_KUBECONFIG" <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: http://127.0.0.1:${proxy_port}
    insecure-skip-tls-verify: true
  name: blink-test-proxy
contexts:
- context:
    cluster: blink-test-proxy
  name: blink-test-proxy
current-context: blink-test-proxy
EOF
  echo "Proxy kubeconfig written to $PROXY_KUBECONFIG"
}

stop_proxy() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
  fi
}

# ---------------------------------------------------------------------------
# Cleanup.
# ---------------------------------------------------------------------------
cleanup() {
  stop_proxy
  rm -f "$KIND_KUBECONFIG" "$PROXY_KUBECONFIG" "$PROXY_LOG"
  if [[ "${KEEP_CLUSTER:-}" != "1" ]]; then
    delete_cluster
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
main() {
  install_kind
  create_cluster

  # Apply RBAC using the real kubeconfig (with certs).
  KUBECONFIG="$KIND_KUBECONFIG" kubectl apply -f "$K8S_DIR/rbac.yaml"

  start_proxy

  echo ""
  echo "=== Running K8s integration tests ==="
  echo ""
  cd "$REPO_ROOT"
  bun install

  # The test loads the proxy kubeconfig — plain HTTP, no TLS issues.
  BLINK_K8S_TEST=1 \
  BLINK_K8S_TEST_KUBECONFIG="$PROXY_KUBECONFIG" \
    bun test packages/server/test/k8s/integration.test.ts || {
    local rc=$?
    echo "Tests failed (exit code $rc)."
    exit $rc
  }

  echo ""
  echo "=== Tests passed ==="
}

main "$@"
