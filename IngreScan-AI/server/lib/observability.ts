/**
 * Logging, error handling, health checks and shutdown. No mandatory third party.
 *
 * Privacy rules: request logs hold method, path (never the query string), status, duration and a request id.
 * Bodies, cookies, Authorization headers, tokens and phone numbers are never logged; error messages are scrubbed.
 * Optional Sentry: set SENTRY_DSN and `pnpm add @sentry/node`; it is imported lazily and only then.
 */
import { randomUUID } from "crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Server } from "http";
import { sql } from "drizzle-orm";
import { closeDatabase, getDbContext } from "../_core/database";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let sink: (line: string) => void = line => process.stdout.write(line + "\n");
/** Tests capture log lines here. */
export function setLogSink(fn: ((line: string) => void) | null) {
  sink = fn ?? (line => process.stdout.write(line + "\n"));
}

function minLevel(): number {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[v] ?? LEVELS.info;
}

/** Removes things that must not reach logs: JWT-like tokens, bearer/basic credentials, key=value secrets, phone numbers, emails. */
export function scrub(text: string, max = 500): string {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization|cookie|sig|signature)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .slice(0, max);
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < minLevel()) return;
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { errName: err.name, errMessage: scrub(err.message) };
    if (err.stack) out.errStack = scrub(err.stack.split("\n").slice(0, 6).join("\n"), 1500);
    return out;
  }
  return { errMessage: scrub(typeof err === "string" ? err : "non-error thrown") };
}

// ---------- request id + access log ----------

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.headers["x-request-id"];
    const id = typeof inbound === "string" && SAFE_ID.test(inbound) ? inbound : randomUUID();
    res.locals.reqId = id;
    res.setHeader("X-Request-Id", id);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const pathOnly = (req.originalUrl || req.url || "").split("?")[0].slice(0, 300);
      const status = res.statusCode;
      const isHealth = pathOnly === "/healthz" || pathOnly === "/readyz";
      const level: Level = status >= 500 ? "error" : status >= 400 ? "warn" : isHealth ? "debug" : "info";
      log(level, "request", {
        reqId: id,
        method: req.method,
        path: pathOnly,
        status,
        durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
      });
    });
    next();
  };
}

// ---------- Sentry hook (optional, lazy) ----------

type SentryLike = { init: (o: Record<string, unknown>) => void; captureException: (e: unknown, c?: unknown) => void; flush?: (ms: number) => Promise<unknown> };
let sentry: SentryLike | null = null;
let sentryTried = false;

export async function initErrorReporting(): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || sentryTried) return sentry !== null;
  sentryTried = true;
  try {
    const moduleName = "@sentry/node"; // variable name: bundlers and tsc do not resolve it, nothing loads when unset
    const mod = (await import(/* @vite-ignore */ moduleName)) as SentryLike;
    mod.init({ dsn, environment: process.env.NODE_ENV, sendDefaultPii: false, tracesSampleRate: 0 });
    sentry = mod;
    log("info", "error_reporting_enabled", { provider: "sentry" });
    return true;
  } catch {
    log("warn", "error_reporting_unavailable", { hint: "SENTRY_DSN is set but @sentry/node is not installed; run: pnpm add @sentry/node" });
    return false;
  }
}

export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  try {
    sentry?.captureException(err, { extra: context });
  } catch {
    // reporting must never throw
  }
}

// ---------- central error handler ----------

export function errorHandler(): (err: any, req: Request, res: Response, next: NextFunction) => void {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const type = err?.type as string | undefined;
    let status = 500;
    let message = "Internal server error.";
    if (type === "entity.too.large") {
      status = 413;
      message = "Request body is too large.";
    } else if (type === "entity.parse.failed" || type === "encoding.unsupported" || type === "charset.unsupported") {
      status = 400;
      message = "Malformed request body.";
    } else if (type === "request.aborted") {
      status = 400;
      message = "Request aborted.";
    } else {
      // Errors raised by Express/body-parser carry a 4xx status for client faults (for example URIError "Failed to decode
      // param" -> 400); report those as such instead of a logged 500.
      const declared = Number(err?.status ?? err?.statusCode);
      if (Number.isInteger(declared) && declared >= 400 && declared < 500) {
        status = declared;
        message = declared === 413 ? "Request body is too large." : declared === 415 ? "Unsupported media type." : "Bad request.";
      }
    }
    if (status >= 500) {
      log("error", "unhandled_route_error", { reqId: res.locals.reqId, method: req.method, path: (req.originalUrl || "").split("?")[0], ...errorFields(err) });
      reportError(err, { reqId: res.locals.reqId });
    }
    const wantsJson = (req.originalUrl || "").startsWith("/api/");
    if (wantsJson) res.status(status).json({ error: message, requestId: res.locals.reqId });
    else res.status(status).type("text/plain").send(`${message} (request ${res.locals.reqId ?? "n/a"})`);
  };
}

// ---------- health ----------

export type HealthState = { shuttingDown: boolean };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(t!)) as Promise<T>;
}

export async function checkDatabase(): Promise<boolean> {
  try {
    const ctx = await withTimeout(getDbContext(), 2000);
    if (!ctx) return false;
    await withTimeout(ctx.db.select({ v: sql<number>`1` }) as unknown as Promise<unknown>, 2000);
    return true;
  } catch {
    return false;
  }
}

export async function checkFlask(): Promise<"up" | "down" | "skipped"> {
  const base = process.env.FRESHGUARD_URL;
  if (!base) return "skipped";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${base.replace(/\/+$/, "")}/api/fruits`, { signal: ctl.signal }).finally(() => clearTimeout(t));
    return r.status < 500 ? "up" : "down";
  } catch {
    return "down";
  }
}

/** /healthz = process is alive. /readyz = can serve: database reachable (Flask reported, required only with READYZ_REQUIRE_FRESHGUARD=1). Bodies never contain error details. */
export function registerHealthRoutes(app: Express, state: HealthState) {
  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (state.shuttingDown) return void res.status(503).json({ status: "shutting_down" });
    const [dbOk, flask] = await Promise.all([checkDatabase(), checkFlask()]);
    const flaskRequired = process.env.READYZ_REQUIRE_FRESHGUARD === "1";
    const ready = dbOk && (!flaskRequired || flask !== "down");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", database: dbOk ? "up" : "down", freshguard: flask });
  });
}

// ---------- process-level handlers + graceful shutdown ----------

export function installProcessHandlers(opts: { server: Server; state: HealthState; onShutdown?: () => void | Promise<void> }) {
  const { server, state } = opts;
  process.on("unhandledRejection", reason => {
    log("error", "unhandled_rejection", errorFields(reason));
    reportError(reason, { kind: "unhandledRejection" });
  });
  process.on("uncaughtException", err => {
    log("error", "uncaught_exception", errorFields(err));
    reportError(err, { kind: "uncaughtException" });
    if (process.env.EXIT_ON_UNCAUGHT === "1") void shutdown("uncaughtException", 1);
  });

  let shuttingDown = false;
  async function shutdown(signal: string, code = 0) {
    if (shuttingDown) {
      log("warn", "shutdown_forced", { signal });
      process.exit(code || 1);
    }
    shuttingDown = true;
    state.shuttingDown = true;
    log("info", "shutdown_started", { signal });
    const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;
    const force = setTimeout(() => {
      log("error", "shutdown_timeout", { timeoutMs });
      process.exit(1);
    }, timeoutMs);
    force.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        let sweep: NodeJS.Timeout | undefined;
        const cleanup = () => {
          if (sweep) {
            clearInterval(sweep);
            sweep = undefined;
          }
        };
        server.close(err => {
          cleanup();
          if (err) reject(err);
          else resolve();
        });
        (server as any).closeIdleConnections?.();
        // Keep-alive connections that become idle after the first sweep.
        sweep = setInterval(() => (server as any).closeIdleConnections?.(), 250);
        sweep.unref();
        server.once("close", cleanup);
      });
      await opts.onShutdown?.();
      await sentry?.flush?.(2000);
      await closeDatabase();
      log("info", "shutdown_complete", {});
      process.exit(code);
    } catch (err) {
      log("error", "shutdown_failed", errorFields(err));
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
