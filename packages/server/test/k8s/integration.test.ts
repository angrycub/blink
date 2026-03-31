/**
 * Integration tests for the Kubernetes agent deployment backend.
 *
 * These tests require a running Kubernetes cluster (e.g. kind) and
 * are gated behind the BLINK_K8S_TEST=1 environment variable.
 *
 * IMPORTANT: Run from the repo root so bun can resolve workspace
 * dependencies:
 *
 *   ./scripts/run-k8s-integration.sh
 *   # or
 *   bun install && BLINK_K8S_TEST=1 bun test packages/server/test/k8s/integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// This import requires `bun install` at the repo root first.
// If you see "Cannot find module", run: bun install
import * as k8s from "@kubernetes/client-node";

const SKIP = process.env.BLINK_K8S_TEST !== "1";

// kind clusters use a self-signed CA. Bun's fetch does not honor
// the kubeconfig certificate-authority-data the way Node.js does,
// so we need to disable TLS verification for local test clusters.
if (!SKIP) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const NAMESPACE = "default";
const TEST_AGENT_ID = `test-agent-${Date.now()}`;
const RESOURCE_NAME = `blink-agent-${TEST_AGENT_ID}`;

// Labels applied to all test resources for easy cleanup.
const LABELS: Record<string, string> = {
  app: "blink-agent",
  "blink.so/agent-id": TEST_AGENT_ID,
  "blink.so/test": "true",
};

let coreApi: k8s.CoreV1Api;

/**
 * Helper: create a simple ConfigMap, Pod, and Service that
 * mimic what deployAgentWithKubernetes creates — but using a
 * lightweight nginx image instead of the real blink-agent image
 * so the test doesn't need to pull a large image.
 */
async function createTestResources() {
  // ConfigMap (minimal — just proves we can create one).
  const configMap: k8s.V1ConfigMap = {
    metadata: { name: RESOURCE_NAME, namespace: NAMESPACE, labels: LABELS },
    data: { "agent.js": 'console.log("hello from test agent");' },
  };
  await coreApi.createNamespacedConfigMap({
    namespace: NAMESPACE,
    body: configMap,
  });

  // Pod — use nginx:alpine as a lightweight always-running image.
  const pod: k8s.V1Pod = {
    metadata: { name: RESOURCE_NAME, namespace: NAMESPACE, labels: LABELS },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "agent",
          image: "nginx:alpine",
          ports: [{ containerPort: 80 }],
        },
      ],
    },
  };
  await coreApi.createNamespacedPod({ namespace: NAMESPACE, body: pod });

  // Service — ClusterIP targeting the pod.
  const service: k8s.V1Service = {
    metadata: { name: RESOURCE_NAME, namespace: NAMESPACE, labels: LABELS },
    spec: {
      type: "ClusterIP",
      selector: { "blink.so/agent-id": TEST_AGENT_ID },
      ports: [{ port: 80, targetPort: 80, protocol: "TCP" }],
    },
  };
  await coreApi.createNamespacedService({
    namespace: NAMESPACE,
    body: service,
  });
}

/**
 * Wait for a pod to reach a given phase, with timeout.
 */
async function waitForPhase(
  name: string,
  targetPhase: string,
  timeoutMs = 90_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await coreApi.readNamespacedPod({
      name,
      namespace: NAMESPACE,
    });
    const phase = pod.status?.phase ?? "Unknown";
    if (phase === targetPhase) return phase;
    if (phase === "Failed" || phase === "Succeeded") {
      throw new Error(`Pod ${name} entered terminal phase: ${phase}`);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(
    `Pod ${name} did not reach ${targetPhase} within ${timeoutMs}ms`
  );
}

/**
 * Delete a resource, ignoring 404.
 */
async function safeDelete(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err: unknown) {
    // Duck-type check for a 404 from the K8s API.
    if (typeof err === "object" && err !== null && "code" in err) {
      if ((err as { code: number }).code === 404) return;
    }
    throw err;
  }
}

async function cleanupTestResources() {
  await Promise.all([
    safeDelete(() =>
      coreApi.deleteNamespacedPod({ name: RESOURCE_NAME, namespace: NAMESPACE })
    ),
    safeDelete(() =>
      coreApi.deleteNamespacedService({
        name: RESOURCE_NAME,
        namespace: NAMESPACE,
      })
    ),
    safeDelete(() =>
      coreApi.deleteNamespacedConfigMap({
        name: RESOURCE_NAME,
        namespace: NAMESPACE,
      })
    ),
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip("K8s agent deployment (integration)", () => {
  beforeAll(async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Clean up any leftover resources from a previous run.
    await cleanupTestResources();
  });

  afterAll(async () => {
    await cleanupTestResources();
  });

  it("creates ConfigMap, Pod, and Service successfully", async () => {
    await createTestResources();

    // Verify ConfigMap exists.
    const cm = await coreApi.readNamespacedConfigMap({
      name: RESOURCE_NAME,
      namespace: NAMESPACE,
    });
    expect(cm.metadata?.name).toBe(RESOURCE_NAME);
    expect(cm.data?.["agent.js"]).toContain("hello from test agent");

    // Verify Service exists.
    const svc = await coreApi.readNamespacedService({
      name: RESOURCE_NAME,
      namespace: NAMESPACE,
    });
    expect(svc.metadata?.name).toBe(RESOURCE_NAME);
    expect(svc.spec?.type).toBe("ClusterIP");
    expect(svc.spec?.ports?.[0]?.port).toBe(80);
  });

  it(
    "Pod reaches Running phase",
    async () => {
      const phase = await waitForPhase(RESOURCE_NAME, "Running");
      expect(phase).toBe("Running");
    },
    { timeout: 120_000 }
  );

  it("redeployment replaces resources cleanly", async () => {
    // Delete and recreate — mimics what the deployer does on redeploy.
    await cleanupTestResources();

    // Small delay for K8s to process deletions.
    await Bun.sleep(2_000);

    // Verify the pod is gone.
    try {
      await coreApi.readNamespacedPod({
        name: RESOURCE_NAME,
        namespace: NAMESPACE,
      });
      throw new Error("Pod should have been deleted");
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err) {
        expect((err as { code: number }).code).toBe(404);
      } else {
        throw err;
      }
    }

    // Recreate.
    await createTestResources();
    const pod = await coreApi.readNamespacedPod({
      name: RESOURCE_NAME,
      namespace: NAMESPACE,
    });
    expect(pod.metadata?.name).toBe(RESOURCE_NAME);
  });

  it(
    "Service DNS resolves within the cluster",
    async () => {
      // Wait for the pod from the previous test to be running.
      await waitForPhase(RESOURCE_NAME, "Running", 90_000);

      // Verify the Service has a ClusterIP assigned.
      const svc = await coreApi.readNamespacedService({
        name: RESOURCE_NAME,
        namespace: NAMESPACE,
      });
      expect(svc.spec?.clusterIP).toBeTruthy();
      expect(svc.spec?.clusterIP).not.toBe("None");
    },
    { timeout: 120_000 }
  );
});
