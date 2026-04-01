import { generateAgentDeploymentToken } from "@blink.so/api/agents/me/server";
import type Querier from "@blink.so/database/querier";
import type { AgentDeployment } from "@blink.so/database/schema";
import {
  BlinkDeploymentTokenEnvironmentVariable,
  InternalAPIServerListenPortEnvironmentVariable,
  InternalAPIServerURLEnvironmentVariable,
} from "@blink.so/runtime/types";
import * as k8s from "@kubernetes/client-node";
import { ApiException } from "@kubernetes/client-node/dist/gen/apis/exception.js";

interface K8sDeployOptions {
  deployment: AgentDeployment;
  querier: Querier;
  baseUrl: string;
  accessUrl: string;
  authSecret: string;
  image: string;
  namespace: string;
  downloadFile: (id: string) => Promise<{
    stream: ReadableStream;
    type: string;
    name: string;
    size: number;
  }>;
  // Override the container command for testing with images that
  // don't have the otel collector or bash.
  commandOverride?: string[];
}

const CONTAINER_EXTERNAL_API_PORT = 3000;
const CONTAINER_INTERNAL_API_PORT = 3010;

// Maximum time to wait for a Pod to reach the Running phase.
const POD_READY_TIMEOUT_MS = 120_000;
const POD_POLL_INTERVAL_MS = 2_000;

/**
 * Kubernetes-based agent deployment for self-hosted Blink.
 * Creates a ConfigMap with agent files, a Pod to run the agent,
 * and a ClusterIP Service to expose it within the cluster.
 */
export async function deployAgentWithKubernetes(opts: K8sDeployOptions) {
  const {
    deployment,
    querier,
    baseUrl,
    authSecret,
    image,
    namespace,
    downloadFile,
    commandOverride,
  } = opts;

  const agentId = deployment.agent_id;
  const resourceName = `blink-agent-${agentId}`;
  const labels: Record<string, string> = {
    app: "blink-agent",
    "blink.so/agent-id": agentId,
    "blink.so/deployment-id": deployment.id,
  };

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  console.log(
    `[k8s] Deploying agent ${agentId} (deployment ${deployment.id}) to namespace ${namespace}`
  );

  try {
    await querier.updateAgentDeployment({
      id: deployment.id,
      status: "deploying",
    });

    if (!deployment.output_files || deployment.output_files.length === 0) {
      throw new Error("No output files provided");
    }

    // ---------------------------------------------------------------
    // 1. Collect agent files into a map of path -> base64 content.
    //    ConfigMaps have a 1 MiB limit; binary data goes into
    //    binaryData as base64. The init container will decode them.
    // ---------------------------------------------------------------
    const fileEntries: Record<string, string> = {};

    for (const file of deployment.output_files) {
      const fileData = await downloadFile(file.id);
      const reader = fileData.stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      // Use a flattened key (replace path separators) for ConfigMap.
      const key = file.path.replace(/\//g, "__");
      fileEntries[key] = buffer.toString("base64");
      console.log(`[k8s] Packed ${file.path} (${buffer.length} bytes)`);
    }

    // Add the node runtime wrapper.
    const runtime = await import("@blink.so/runtime/node/wrapper");
    fileEntries["__wrapper.js"] = Buffer.from(runtime.default).toString(
      "base64"
    );
    console.log("[k8s] Packed __wrapper.js (runtime wrapper)");

    const originalEntrypoint = deployment.entrypoint;

    // ---------------------------------------------------------------
    // 2. Build environment variables (same set as the Docker deployer).
    // ---------------------------------------------------------------
    const envs = await querier.selectAgentEnvironmentVariablesByAgentID({
      agentID: agentId,
    });
    const target = await querier.selectAgentDeploymentTargetByID(
      deployment.target_id
    );

    // In K8s the server and agent Pods share cluster networking, so
    // the container can reach the server at its in-cluster Service URL
    // directly — no Docker networking workarounds needed.
    const containerBaseUrl = baseUrl.replace(/\/$/, "");

    const envVars: k8s.V1EnvVar[] = [
      { name: "ENTRYPOINT", value: `./${originalEntrypoint}` },
      {
        name: InternalAPIServerListenPortEnvironmentVariable,
        value: String(CONTAINER_INTERNAL_API_PORT),
      },
      {
        name: InternalAPIServerURLEnvironmentVariable,
        value: containerBaseUrl,
      },
      { name: "BLINK_REQUEST_URL", value: containerBaseUrl },
      { name: "BLINK_REQUEST_ID", value: target?.request_id ?? "" },
      { name: "PORT", value: String(CONTAINER_EXTERNAL_API_PORT) },
      { name: "BLINK_USE_STRUCTURED_LOGGING", value: "1" },
    ];

    for (const envVar of envs) {
      if (envVar.value !== null) {
        envVars.push({ name: envVar.key, value: envVar.value });
      }
    }

    const deploymentToken = await generateAgentDeploymentToken(authSecret, {
      agent_id: agentId,
      agent_deployment_id: deployment.id,
      agent_deployment_target_id: deployment.target_id,
    });
    envVars.push({
      name: BlinkDeploymentTokenEnvironmentVariable,
      value: deploymentToken,
    });

    // ---------------------------------------------------------------
    // 3. Clean up any previous K8s resources for this agent.
    // ---------------------------------------------------------------
    await deleteK8sResources(coreApi, namespace, resourceName);

    // ---------------------------------------------------------------
    // 4. Create ConfigMap with agent files.
    // ---------------------------------------------------------------
    const configMap: k8s.V1ConfigMap = {
      metadata: {
        name: resourceName,
        namespace,
        labels,
      },
      binaryData: fileEntries,
    };
    await coreApi.createNamespacedConfigMap({ namespace, body: configMap });
    console.log(`[k8s] ConfigMap ${resourceName} created`);

    // ---------------------------------------------------------------
    // 5. Build the init-container script that decodes ConfigMap files
    //    from base64 into /app with their original paths.
    // ---------------------------------------------------------------
    const copyCommands = Object.keys(fileEntries)
      .map((key) => {
        // Reverse the flattened key back to a path.
        const originalPath = key.replace(/__/g, "/");
        return `mkdir -p /app/$(dirname "${originalPath}") && base64 -d /configmap/${key} > /app/${originalPath}`;
      })
      .join(" && ");

    // ---------------------------------------------------------------
    // 6. Create the Pod.
    // ---------------------------------------------------------------
    const pod: k8s.V1Pod = {
      metadata: {
        name: resourceName,
        namespace,
        labels,
      },
      spec: {
        restartPolicy: "Never",
        initContainers: [
          {
            name: "copy-files",
            image: "busybox",
            command: ["sh", "-c", copyCommands],
            volumeMounts: [
              { name: "agent-files", mountPath: "/app" },
              {
                name: "configmap-volume",
                mountPath: "/configmap",
                readOnly: true,
              },
            ],
          },
        ],
        containers: [
          {
            name: "agent",
            image,
            command: commandOverride ?? [
              "bash",
              "-c",
              "/opt/otel/start-collector.sh && node __wrapper.js 2>&1 | tee /var/log/agent/agent.pipe",
            ],
            workingDir: "/app",
            ports: [{ containerPort: CONTAINER_EXTERNAL_API_PORT }],
            env: envVars,
            volumeMounts: [{ name: "agent-files", mountPath: "/app" }],
          },
        ],
        volumes: [
          { name: "agent-files", emptyDir: {} },
          {
            name: "configmap-volume",
            configMap: { name: resourceName },
          },
        ],
      },
    };

    await coreApi.createNamespacedPod({ namespace, body: pod });
    console.log(`[k8s] Pod ${resourceName} created`);

    // ---------------------------------------------------------------
    // 7. Create a ClusterIP Service to expose the agent's port.
    // ---------------------------------------------------------------
    const service: k8s.V1Service = {
      metadata: {
        name: resourceName,
        namespace,
        labels,
      },
      spec: {
        type: "ClusterIP",
        selector: {
          "blink.so/agent-id": agentId,
        },
        ports: [
          {
            port: CONTAINER_EXTERNAL_API_PORT,
            targetPort: CONTAINER_EXTERNAL_API_PORT,
            protocol: "TCP",
          },
        ],
      },
    };

    await coreApi.createNamespacedService({ namespace, body: service });
    console.log(`[k8s] Service ${resourceName} created`);

    // ---------------------------------------------------------------
    // 8. Update deployment record with the in-cluster access URL.
    //    Like the Docker deployer, we mark the deployment as
    //    successful immediately after creating the resources rather
    //    than waiting for the Pod to become Running. The Pod will
    //    start asynchronously.
    // ---------------------------------------------------------------
    const directAccessUrl = `http://${resourceName}.${namespace}.svc.cluster.local:${CONTAINER_EXTERNAL_API_PORT}`;

    await querier.tx(async (tx) => {
      await tx.updateAgentDeployment({
        id: deployment.id,
        status: "success",
        direct_access_url: directAccessUrl,
        platform_metadata: {
          type: "lambda",
          arn: `k8s:${namespace}/${resourceName}`,
        },
      });

      const deploymentTarget = await tx.selectAgentDeploymentTargetByID(
        deployment.target_id
      );
      if (deploymentTarget && deploymentTarget.target === "production") {
        await tx.updateAgent({
          id: agentId,
          active_deployment_id: deployment.id,
        });
      }
    });

    console.log(`[k8s] Deployment ${deployment.id} successful`);
  } catch (error) {
    console.error(`[k8s] Deployment ${deployment.id} failed:`, error);
    await querier.updateAgentDeployment({
      id: deployment.id,
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
    });

    // Best-effort cleanup of any partial resources.
    try {
      await deleteK8sResources(coreApi, namespace, resourceName);
    } catch (cleanupErr) {
      console.error("[k8s] Cleanup after failure also failed:", cleanupErr);
    }

    throw error;
  }
}

/**
 * Delete previously created K8s resources for an agent.
 * Ignores 404 (not found) errors so this is safe to call
 * even when resources don't exist yet.
 */
async function deleteK8sResources(
  api: k8s.CoreV1Api,
  namespace: string,
  name: string
): Promise<void> {
  const deletions = [
    api
      .deleteNamespacedPod({ namespace, name })
      .catch(ignore404),
    api
      .deleteNamespacedService({ namespace, name })
      .catch(ignore404),
    api
      .deleteNamespacedConfigMap({ namespace, name })
      .catch(ignore404),
  ];
  await Promise.all(deletions);
  console.log(`[k8s] Cleaned up previous resources for ${name}`);
}

/**
 * Poll until a Pod reaches the Running phase or the timeout expires.
 */
async function waitForPodRunning(
  api: k8s.CoreV1Api,
  namespace: string,
  name: string
): Promise<void> {
  const deadline = Date.now() + POD_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const pod = await api.readNamespacedPod({ name, namespace });
    const phase = pod.status?.phase;

    if (phase === "Running") {
      console.log(`[k8s] Pod ${name} is Running`);
      return;
    }

    if (phase === "Failed" || phase === "Succeeded") {
      throw new Error(
        `Pod ${name} entered terminal phase "${phase}" before becoming ready`
      );
    }

    await new Promise((r) => setTimeout(r, POD_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Pod ${name} did not reach Running phase within ${POD_READY_TIMEOUT_MS / 1000}s`
  );
}

/**
 * Swallow Kubernetes 404 errors so cleanup is idempotent.
 */
function isK8s404(err: unknown): boolean {
  // ApiException from @kubernetes/client-node uses .code for HTTP status.
  if (err instanceof ApiException && err.code === 404) {
    return true;
  }
  // Fallback: duck-type check for any error-like object with a 404 status.
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: number }).code === 404
  ) {
    return true;
  }
  return false;
}

function ignore404(err: unknown): void {
  if (isK8s404(err)) {
    return;
  }
  throw err;
}
