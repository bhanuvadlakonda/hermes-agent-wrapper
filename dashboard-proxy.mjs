import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

const listenHost = "0.0.0.0";
const listenPort = Number(process.env.PORT || process.env.DASHBOARD_PROXY_PORT || 8080);
const target = new URL(process.env.HERMES_DASHBOARD_URL || "http://127.0.0.1:9119");
const username = process.env.DASHBOARD_USERNAME || "";
const password = process.env.DASHBOARD_PASSWORD || "";
const realm = process.env.DASHBOARD_AUTH_REALM || "Hermes Dashboard";
const cookieName = process.env.DASHBOARD_AUTH_COOKIE || "hermes_dashboard_auth";
const cookieMaxAgeSeconds = Number(process.env.DASHBOARD_AUTH_COOKIE_MAX_AGE || 60 * 60 * 12);
const signingSecret = process.env.DASHBOARD_SESSION_SECRET || `${username}:${password}`;

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function credentialsConfigured() {
  return username.length > 0 && password.length > 0;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac("sha256", signingSecret).update(value).digest("base64url");
}

function signedCookieValue() {
  const issuedAt = Math.floor(Date.now() / 1000).toString();
  return `${issuedAt}.${sign(issuedAt)}`;
}

function validCookie(req) {
  if (!credentialsConfigured()) {
    return false;
  }

  const cookie = req.headers.cookie || "";
  const found = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));

  if (!found) {
    return false;
  }

  const value = decodeURIComponent(found.slice(cookieName.length + 1));
  const [issuedAt, signature] = value.split(".");
  const issuedAtNumber = Number(issuedAt);
  if (!issuedAt || !signature || !Number.isFinite(issuedAtNumber)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - issuedAtNumber > cookieMaxAgeSeconds) {
    return false;
  }

  return safeEqual(signature, sign(issuedAt));
}

function basicAuthorized(req) {
  if (!credentialsConfigured()) {
    return false;
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  return safeEqual(decoded, `${username}:${password}`);
}

function authorized(req) {
  return validCookie(req) || basicAuthorized(req);
}

function setAuthCookie(res) {
  if (!credentialsConfigured()) {
    return;
  }

  res.setHeader(
    "set-cookie",
    `${cookieName}=${encodeURIComponent(signedCookieValue())}; Max-Age=${cookieMaxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function writeAuthRequired(res) {
  if (!credentialsConfigured()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Hermes dashboard auth is not configured yet.\n");
    return;
  }

  res.writeHead(401, {
    "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`,
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required.\n");
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (hopByHopHeaders.has(name.toLowerCase())) {
      delete headers[name];
    }
  }

  if (typeof headers.authorization === "string" && headers.authorization.startsWith("Basic ")) {
    delete headers.authorization;
  }
  headers.host = target.host;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "https";
  // Keep the upstream dashboard seeing this same-container proxy as the client.
  // Forwarding the public browser IP makes Hermes' localhost-only WebSocket
  // guard reject /api/pty and /api/events.
  delete headers["x-forwarded-for"];
  return headers;
}

const server = http.createServer((req, res) => {
  if (req.url === "/__health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }

  if (!authorized(req)) {
    writeAuthRequired(res);
    return;
  }

  if (basicAuthorized(req)) {
    setAuthCookie(res);
  }

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req),
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of Object.keys(responseHeaders)) {
        if (hopByHopHeaders.has(name.toLowerCase())) {
          delete responseHeaders[name];
        }
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    console.error(`[dashboard-proxy] upstream error: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Dashboard upstream unavailable.\n");
  });

  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    const status = credentialsConfigured() ? "401 Unauthorized" : "503 Service Unavailable";
    const authHeader = credentialsConfigured()
      ? `WWW-Authenticate: Basic realm="${realm}", charset="UTF-8"\r\n`
      : "";
    socket.write(`HTTP/1.1 ${status}\r\n${authHeader}Connection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    const headers = proxyHeaders(req);
    headers.connection = "Upgrade";
    if (req.headers.upgrade) {
      headers.upgrade = req.headers.upgrade;
    }

    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          upstream.write(`${name}: ${item}\r\n`);
        }
      } else if (value !== undefined) {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", (error) => {
    console.error(`[dashboard-proxy] websocket upstream error: ${error.message}`);
    socket.destroy();
  });
});

server.listen(listenPort, listenHost, () => {
  const authState = credentialsConfigured() ? "enabled" : "not configured";
  console.log(
    `[dashboard-proxy] listening on ${listenHost}:${listenPort}; auth ${authState}; target ${target.href}`,
  );
});
