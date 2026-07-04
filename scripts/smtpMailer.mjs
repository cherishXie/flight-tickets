import { connect as netConnect } from "net";
import { connect as tlsConnect } from "tls";

const DEFAULT_SMTP_TIMEOUT_MS = 20000;

export function getSmtpConfig(env = process.env) {
  const host = String(env.SMTP_HOST || "").trim();
  const secure = parseBoolean(env.SMTP_SECURE, Number(env.SMTP_PORT) === 465);
  const port = clampNumber(env.SMTP_PORT, 1, 65535, secure ? 465 : 587);
  const user = String(env.SMTP_USER || "").trim();
  const password = String(env.SMTP_PASS || "");
  const from = String(env.SMTP_FROM || user || "").trim();
  const fromAddress = extractEmailAddress(from);
  return {
    provider: "smtp",
    configured: Boolean(host && fromAddress),
    host,
    port,
    secure,
    requireTls: parseBoolean(env.SMTP_REQUIRE_TLS, true),
    user,
    password,
    authConfigured: Boolean(user && password),
    from,
    fromAddress,
    timeoutMs: clampNumber(env.SMTP_TIMEOUT_MS, 1000, 120000, DEFAULT_SMTP_TIMEOUT_MS)
  };
}

export function publicSmtpStatus(config = getSmtpConfig()) {
  return {
    provider: "smtp",
    configured: config.configured,
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTls: config.requireTls,
    authConfigured: config.authConfigured,
    from: config.from,
    fromAddress: config.fromAddress,
    timeoutMs: config.timeoutMs
  };
}

export async function checkSmtpHealth(env = process.env) {
  const config = getSmtpConfig(env);
  const checkedAt = new Date().toISOString();
  if (!config.configured) {
    return {
      ...publicSmtpStatus(config),
      ok: false,
      checkedAt,
      message: "SMTP 未配置。请设置 SMTP_HOST 和 SMTP_FROM，或设置 SMTP_USER 作为发件人。"
    };
  }

  let connection = null;
  try {
    connection = await createSmtpConnection(config);
    await connection.command(null, [220]);
    let capabilities = await ehlo(connection);

    if (!config.secure && config.requireTls && hasCapability(capabilities, "STARTTLS")) {
      await connection.command("STARTTLS", [220]);
      await connection.upgradeToTls(config);
      capabilities = await ehlo(connection);
    }

    if (!config.secure && config.requireTls && !connection.encrypted) {
      throw new Error("SMTP 服务器未启用 TLS，已按 SMTP_REQUIRE_TLS 要求停止。");
    }

    if (config.authConfigured) {
      if (!hasCapability(capabilities, "AUTH")) {
        throw new Error("SMTP 服务器未声明 AUTH 能力，无法使用账号密码登录。");
      }
      const authPlain = Buffer.from(`\0${config.user}\0${config.password}`, "utf8").toString("base64");
      await connection.command(`AUTH PLAIN ${authPlain}`, [235]);
    }

    await connection.command("QUIT", [221]);
    return {
      ...publicSmtpStatus(config),
      ok: true,
      checkedAt,
      message: "SMTP 连接验证成功。"
    };
  } catch (error) {
    return {
      ...publicSmtpStatus(config),
      ok: false,
      checkedAt,
      message: error.message
    };
  } finally {
    connection?.close();
  }
}

export async function sendEmailViaSmtp(draft, config = getSmtpConfig()) {
  if (!config.configured) {
    throw new Error("SMTP 未配置。请设置 SMTP_HOST 和 SMTP_FROM，或设置 SMTP_USER 作为发件人。");
  }

  const recipients = parseRecipients(draft.to);
  if (!recipients.length) {
    throw new Error("SMTP 收件人为空。");
  }

  const connection = await createSmtpConnection(config);
  try {
    await connection.command(null, [220]);
    let capabilities = await ehlo(connection);

    if (!config.secure && config.requireTls && hasCapability(capabilities, "STARTTLS")) {
      await connection.command("STARTTLS", [220]);
      await connection.upgradeToTls(config);
      capabilities = await ehlo(connection);
    }

    if (!config.secure && config.requireTls && !connection.encrypted) {
      throw new Error("SMTP 服务器未启用 TLS，已按 SMTP_REQUIRE_TLS 要求停止发送。");
    }

    if (config.authConfigured) {
      if (!hasCapability(capabilities, "AUTH")) {
        throw new Error("SMTP 服务器未声明 AUTH 能力，无法使用账号密码登录。");
      }
      const authPlain = Buffer.from(`\0${config.user}\0${config.password}`, "utf8").toString("base64");
      await connection.command(`AUTH PLAIN ${authPlain}`, [235]);
    }

    await connection.command(`MAIL FROM:<${config.fromAddress}>`, [250]);
    for (const recipient of recipients) {
      await connection.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await connection.command("DATA", [354]);
    connection.write(`${dotStuff(buildSmtpMessage(draft, config))}\r\n.`);
    await connection.command(null, [250]);
    await connection.command("QUIT", [221]);
  } finally {
    connection.close();
  }
}

export function buildSmtpMessage(draft, config = getSmtpConfig(), createdAt = new Date()) {
  return [
    `From: ${sanitizeHeader(config.from)}`,
    `To: ${sanitizeHeader(draft.to)}`,
    `Subject: ${sanitizeHeader(draft.subject)}`,
    `Date: ${createdAt.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(draft.body || "")
  ].join("\r\n");
}

function ehlo(connection) {
  return connection.command("EHLO localhost", [250]);
}

function hasCapability(capabilities, name) {
  const target = String(name || "").toUpperCase();
  return (capabilities || []).some((line) => line.toUpperCase().includes(target));
}

function createSmtpConnection(config) {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port });
    const connection = createConnectionState(socket, config.timeoutMs);
    const onReady = () => resolveConnection(connection);
    const onError = (error) => rejectConnection(error);
    socket.once(config.secure ? "secureConnect" : "connect", onReady);
    socket.once("error", onError);
  });
}

function createConnectionState(initialSocket, timeoutMs) {
  let socket = initialSocket;
  let buffer = "";
  let activeRead = null;
  let encrypted = Boolean(socket.encrypted);

  function attach(nextSocket) {
    socket = nextSocket;
    encrypted = Boolean(socket.encrypted);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`SMTP 请求超时（${timeoutMs}ms）。`);
      if (activeRead) {
        activeRead.reject(error);
        activeRead = null;
      }
      socket.destroy(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      pump();
    });
    socket.on("error", (error) => {
      if (activeRead) {
        activeRead.reject(error);
        activeRead = null;
      }
    });
  }

  function readResponse() {
    if (activeRead) {
      throw new Error("SMTP 响应读取仍在进行。");
    }
    return new Promise((resolveResponse, rejectResponse) => {
      activeRead = {
        lines: [],
        resolve: resolveResponse,
        reject: rejectResponse
      };
      pump();
    });
  }

  function pump() {
    if (!activeRead) return;
    while (buffer.includes("\n")) {
      const newlineIndex = buffer.indexOf("\n");
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      activeRead.lines.push(line);
      if (/^\d{3}(?:\s|$)/.test(line)) {
        const response = activeRead.lines;
        activeRead.resolve(response);
        activeRead = null;
        return;
      }
    }
  }

  attach(socket);

  return {
    get encrypted() {
      return encrypted;
    },
    async command(command, expectedCodes) {
      if (command !== null) {
        socket.write(`${command}\r\n`);
      }
      const lines = await readResponse();
      const code = Number(lines.at(-1)?.slice(0, 3));
      if (!expectedCodes.includes(code)) {
        throw new Error(`SMTP 返回异常：${lines.join(" | ")}`);
      }
      return lines;
    },
    write(text) {
      socket.write(`${text}\r\n`);
    },
    upgradeToTls(config) {
      return new Promise((resolveUpgrade, rejectUpgrade) => {
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("timeout");
        const tlsSocket = tlsConnect({ socket, servername: config.host });
        tlsSocket.once("secureConnect", () => {
          buffer = "";
          attach(tlsSocket);
          resolveUpgrade();
        });
        tlsSocket.once("error", rejectUpgrade);
      });
    },
    close() {
      socket.end();
    }
  };
}

function parseRecipients(value) {
  return String(value || "")
    .split(/[;,]/)
    .map(extractEmailAddress)
    .filter(Boolean);
}

function extractEmailAddress(value) {
  const text = String(value || "").trim();
  const bracketMatch = text.match(/<([^<>@\s]+@[^<>\s]+)>/);
  if (bracketMatch) return bracketMatch[1].trim();
  const plainMatch = text.match(/[^\s<>;,]+@[^\s<>;,]+/);
  return plainMatch ? plainMatch[0].trim() : "";
}

function dotStuff(message) {
  return String(message || "")
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
