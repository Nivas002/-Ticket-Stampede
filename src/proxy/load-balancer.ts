import Fastify from "fastify";
import { request } from "undici";

export interface LoadBalancerOptions {
  port?: number;
  targetUrls?: string[];
}

export function createLoadBalancer(options: LoadBalancerOptions = {}) {
  const port = options.port ?? 8080;
  const targetUrls = options.targetUrls ?? [
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "http://127.0.0.1:3003",
  ];

  let nextIndex = 0;
  const getNextTarget = () => {
    const url = targetUrls[nextIndex % targetUrls.length];
    nextIndex++;
    return url;
  };

  const app = Fastify({ logger: false });

  // Proxy all incoming traffic to target instances round-robin
  app.all("*", async (req, reply) => {
    const targetBase = getNextTarget();
    const targetUrl = `${targetBase}${req.url}`;

    try {
      const response = await request(targetUrl, {
        method: req.method as any,
        headers: {
          "content-type": "application/json",
        },
        body: req.body ? JSON.stringify(req.body) : undefined,
      });

      const bodyText = await response.body.text();
      reply.code(response.statusCode);
      for (const [key, val] of Object.entries(response.headers)) {
        if (val && key !== "transfer-encoding" && key !== "content-length") {
          reply.header(key, val);
        }
      }

      return reply.send(bodyText);
    } catch (err: any) {
      return reply.code(502).send({
        success: false,
        reason: "PROXY_ERROR",
        message: err.message || "Failed to route to target instance",
      });
    }
  });

  return {
    app,
    start: async () => {
      await app.listen({ port, host: "0.0.0.0" });
      return `http://127.0.0.1:${port}`;
    },
    stop: async () => {
      await app.close();
    },
  };
}

if (require.main === module) {
  const lb = createLoadBalancer();
  lb.start().then((url) => {
    console.log(`[Load Balancer Proxy] Listening on ${url}`);
  });
}
