import { createReadStream, existsSync, statSync } from "fs";
import { createServer } from "http";
import { extname, join, normalize, resolve } from "path";
import { checkAmadeusHealth, collectAmadeusSnapshots, getAmadeusConfig } from "./amadeusFlightSource.mjs";
import { loadLocalEnv } from "./localEnv.mjs";

loadLocalEnv();

const root = resolve(".");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/api/price-source-status") {
    const deep = url.searchParams.get("deep") === "1";
    sendJson(response, 200, deep ? await publicPriceSourceHealth() : publicPriceSourceStatus());
    return;
  }

  if (url.pathname === "/api/price-snapshots" && request.method === "POST") {
    try {
      const payload = await readJsonBody(request);
      const result = await collectAmadeusSnapshots(payload);
      sendJson(response, 200, result);
    } catch (error) {
      const statusCode = error.message.includes("未配置") ? 503 : 502;
      sendJson(response, statusCode, {
        error: {
          message: error.message
        },
        status: publicPriceSourceStatus()
      });
    }
    return;
  }

  const requestedPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, "index.html");
  }

  response.writeHead(200, {
    "Content-Type": types[extname(filePath)] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
}).listen(port, host, () => {
  console.log(`Serving http://${host}:${port}/`);
  const status = publicPriceSourceStatus();
  console.log(`Live price source: ${status.amadeus.configured ? "Amadeus enabled" : "Amadeus not configured"}`);
});

function publicPriceSourceStatus() {
  const amadeus = getAmadeusConfig();
  return {
    amadeus: {
      configured: amadeus.configured,
      environment: amadeus.environment,
      baseUrl: amadeus.baseUrl,
      requestTimeoutMs: amadeus.requestTimeoutMs,
      retryCount: amadeus.retryCount
    }
  };
}

async function publicPriceSourceHealth() {
  const health = await checkAmadeusHealth();
  return {
    amadeus: health
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        rejectBody(new Error("请求体过大。"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(new Error("请求 JSON 格式无效。"));
      }
    });
    request.on("error", rejectBody);
  });
}
