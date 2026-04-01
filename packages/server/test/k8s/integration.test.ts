/**
 * End-to-end integration test for Kubernetes agent deployment.
 *
 * Starts a real blink-server with --deploy-mode=kubernetes, creates
 * an agent via the API, then triggers a deployment and verifies the
 * K8s resources are created correctly.
 *
 * Prerequisites:
 *   - kind cluster running (via scripts/run-k8s-integration.sh)
 *   - BLINK_K8S_TEST=1
 *   - KUBECONFIG pointing at the kubectl proxy kubeconfig
 *   - Docker running with postgres:16-alpine on port 5432
 *
 * Run via: ./scripts/run-k8s-integration.sh
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as k8s from "@kubernetes/client-node";

const SKIP = process.env.BLINK_K8S_TEST !== "1";
const NAMESPACE = "default";

let coreApi: k8s.CoreV1Api;
let server: Awaited<ReturnType<typeof import("../../src/test").serve>>;
let agentId: string | undefined;

function loadTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const kubeconfigPath = process.env.BLINK_K8S_TEST_KUBECONFIG;
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

async function safeDelete(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err) {
      if ((err as { code: number }).code === 404) return;
    }
    throw err;
  }
}

async function cleanupK8sResources(id: string) {
  const name = `blink-agent-${id}`;
  await Promise.all([
    safeDelete(() =>
      coreApi.deleteNamespacedPod({ name, namespace: NAMESPACE })
    ),
    safeDelete(() =>
      coreApi.deleteNamespacedService({ name, namespace: NAMESPACE })
    ),
    safeDelete(() =>
      coreApi.deleteNamespacedConfigMap({ name, namespace: NAMESPACE })
    ),
  ]);
}

const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip("K8s agent deployment (end-to-end)", () => {
  beforeAll(async () => {
    const kc = loadTestKubeConfig();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);

    // Start a real blink-server in kubernetes deploy mode.
    // Uses a real Postgres (Docker container on port 5432) to
    // avoid PGlite's single-connection limitation.
    const { serve } = await import("../../src/test");
    server = await serve({
      postgresUrl: process.env.BLINK_TEST_POSTGRES_URL ?? "postgresql://postgres:test@localhost:5432/blink",
      enableSignups: true,
      devProxy: false,
      wildcardAccessUrl: false,
      deployMode: "kubernetes",
      k8sNamespace: NAMESPACE,
      // node:alpine doesn't have bash or the otel collector.
      k8sCommandOverride: ["node", "__wrapper.js"],
    });
  }, 60_000);

  afterAll(async () => {
    if (agentId) {
      await cleanupK8sResources(agentId);
    }
    if (server) {
      await server[Symbol.asyncDispose]();
    }
  }, 30_000);

  it(
    "deploys an agent to Kubernetes and creates K8s resources",
    async () => {
      const { user, client } = await server.helpers.createUser();
      const orgs = await client.organizations.list();
      const orgId = orgs[0]!.id;

      // Upload the agent file.
      const agentCode = `
const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", agent: "k8s-e2e-test" }));
});
server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Test agent listening on port " + (process.env.PORT || 3000));
});
`;
      const uploaded = await client.files.upload(
        new File([Buffer.from(agentCode)], "agent.js", {
          type: "application/javascript",
        })
      );

      // Create the agent WITHOUT output_files — this avoids the
      // db.tx() + deployAgent deadlock. The agent gets created but
      // no deployment is triggered yet.
      const agentName = `k8s-e2e-test-${Date.now()}`;
      const agent = await client.agents.create({
        name: agentName,
        organization_id: orgId,
        entrypoint: "agent.js",
        output_files: undefined,
        source_files: undefined,
        env: [],
      });
      agentId = agent.id;
      console.log(`Agent created: ${agent.id} (${agent.name})`);

      // Now trigger a deployment separately — this goes through
      // deployments.server.ts which calls deployAgent outside a tx.
      const deployment = await client.agents.deployments.create({
        agent_id: agent.id,
        target: "production",
        entrypoint: "agent.js",
        output_files: [{ path: "agent.js", id: uploaded.id }],
        source_files: [],
      });
      console.log(`Deployment created: ${deployment.id} (status: ${deployment.status})`);

      // Poll for deployment completion.
      let current: any = deployment;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        current = await client.agents.deployments.get({
          agent_id: agent.id,
          deployment_id: deployment.id,
        });
        if (current.status === "success" || current.status === "failed") {
          break;
        }
        await Bun.sleep(2_000);
      }

      console.log(`Final deployment status: ${current.status}`);
      if (current.status === "failed") {
        console.log(`Error: ${current.error_message}`);
      }

      // Verify K8s resources.
      const resourceName = `blink-agent-${agent.id}`;

      const cm = await coreApi.readNamespacedConfigMap({
        name: resourceName,
        namespace: NAMESPACE,
      });
      expect(cm.metadata?.name).toBe(resourceName);
      expect(cm.binaryData?.["agent.js"]).toBeTruthy();
      expect(cm.binaryData?.["__wrapper.js"]).toBeTruthy();

      const pod = await coreApi.readNamespacedPod({
        name: resourceName,
        namespace: NAMESPACE,
      });
      expect(pod.metadata?.name).toBe(resourceName);
      expect(pod.metadata?.labels?.["blink.so/agent-id"]).toBe(agent.id);

      const mainContainer = pod.spec?.containers?.find(
        (c) => c.name === "agent"
      );
      expect(mainContainer).toBeTruthy();
      expect(mainContainer?.workingDir).toBe("/app");
      expect(mainContainer?.ports?.[0]?.containerPort).toBe(3000);

      const envMap = new Map(
        mainContainer?.env?.map((e) => [e.name, e.value])
      );
      expect(envMap.get("ENTRYPOINT")).toBe("./agent.js");
      expect(envMap.get("PORT")).toBe("3000");

      const svc = await coreApi.readNamespacedService({
        name: resourceName,
        namespace: NAMESPACE,
      });
      expect(svc.metadata?.name).toBe(resourceName);
      expect(svc.spec?.type).toBe("ClusterIP");
      expect(svc.spec?.ports?.[0]?.port).toBe(3000);
      expect(svc.spec?.clusterIP).toBeTruthy();
      expect(svc.spec?.clusterIP).not.toBe("None");

      expect(current.status).toBe("success");
      // The direct_access_url is set in the database but may not be
      // exposed through the API. Verify via K8s Service instead.
      expect(svc.spec?.clusterIP).toBeTruthy();
    },
    { timeout: 180_000 }
  );
});
