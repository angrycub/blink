#!/usr/bin/env bash
# run-k8s-integration.sh
#
# Spins up a kind cluster, applies RBAC, runs the Kubernetes
# deployment integration test, and tears everything down.
#
# Usage:
#   ./scripts/run-k8s-integration.sh
#
# Prerequisites: docker, kind (installed automatically if missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

KIND_CLUSTER_NAME="blink-test"
K8S_DIR="$REPO_ROOT/packages/server/test/k8s"

# ---------------------------------------------------------------------------
# Install kind if it's not on PATH.
# ---------------------------------------------------------------------------
install_kind() {
  if command -v kind &>/dev/null; then
    echo "kind already installed: $(kind version)"
    return
  fi
  echo "Installing kind..."
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  curl -Lo /tmp/kind "https://kind.sigs.k8s.io/dl/v0.27.0/kind-linux-${arch}"
  chmod +x /tmp/kind
  sudo mv /tmp/kind /usr/local/bin/kind
  echo "kind installed: $(kind version)"
}

# ---------------------------------------------------------------------------
# Cluster lifecycle.
# ---------------------------------------------------------------------------
create_cluster() {
  if kind get clusters 2>/dev/null | grep -q "^${KIND_CLUSTER_NAME}$"; then
    echo "Cluster ${KIND_CLUSTER_NAME} already exists, reusing."
    return
  fi
  echo "Creating kind cluster '${KIND_CLUSTER_NAME}'..."
  kind create cluster --config "$K8S_DIR/kind-config.yaml" --wait 60s
}

delete_cluster() {
  echo "Deleting kind cluster '${KIND_CLUSTER_NAME}'..."
  kind delete cluster --name "${KIND_CLUSTER_NAME}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
main() {
  install_kind
  create_cluster

  # Point kubectl at the kind cluster.
  export KUBECONFIG="$(kind get kubeconfig-path --name="${KIND_CLUSTER_NAME}" 2>/dev/null || echo "${HOME}/.kube/config")"
  kubectl config use-context "kind-${KIND_CLUSTER_NAME}"

  echo "Applying RBAC..."
  kubectl apply -f "$K8S_DIR/rbac.yaml"

  echo ""
  echo "=== Running K8s integration tests ==="
  echo ""
  cd "$REPO_ROOT"
  # The test file uses bun:test and talks to the kind cluster
  # via the default kubeconfig.
  BLINK_K8S_TEST=1 bun test packages/server/test/k8s/integration.test.ts || {
    local rc=$?
    echo "Tests failed (exit code $rc). Cleaning up..."
    delete_cluster
    exit $rc
  }

  echo ""
  echo "=== Tests passed — cleaning up ==="
  delete_cluster
}

# Allow skipping teardown for debugging with KEEP_CLUSTER=1.
trap 'if [[ "${KEEP_CLUSTER:-}" != "1" ]]; then delete_cluster; fi' EXIT
main "$@"
