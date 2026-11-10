// The HTTP app: serves the page and streams each chat turn to it as server-sent events. Built by a
// function so tests can run it on a spare port with a throwaway memory.
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { Response } from "express";
import type { Memory } from "./memory/db.ts";
import { runTurn } from "./agent.ts";
import { providers } from "./llm.ts";
import { addDemoHistory, hasDemo } from "./demo.ts";

const chatBody = z.object({ sessionId: z.string().min(1).max(100), message: z.string().trim().min(1).max(4000) });

/** Opens a server-sent event stream. Closing the tab aborts the signal, which cancels models and searches. */
function eventStream(res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const ctrl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ctrl.abort(new Error("client disconnected"));
  });
  return { send: (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`), signal: ctrl.signal };
}

export function createApp(mem: Memory) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  // Markdown rendering and sanitising in the browser, served from node_modules: no CDN, pinned versions.
  const vendor = (pkgPath: string) => fileURLToPath(new URL(`../node_modules/${pkgPath}`, import.meta.url));
  app.get("/vendor/marked.js", (_req, res) => res.sendFile(vendor("marked/lib/marked.esm.js")));
  app.get("/vendor/purify.js", (_req, res) => res.sendFile(vendor("dompurify/dist/purify.es.mjs")));

  // Which models are set up; never the keys themselves.
  app.get("/api/status", (_req, res) => {
    res.json({ models: providers().map((p) => `${p.name}: ${p.main.model}`), search: Boolean(process.env.TAVILY_API_KEY), stored: mem.stats().n, demo: hasDemo(mem) });
  });

  // A conversation's turns, so a reload shows it again.
  app.get("/api/session/:id", (req, res) => {
    res.json(mem.session(req.params.id, 200).map(({ id, askedAt, question, answer, sources, model, origin }) => ({ id, askedAt, question, answer, sources, model, origin })));
  });

  // Everything memory holds, newest first, so the user can check what the agent says it remembers.
  app.get("/api/history", (_req, res) => res.json(mem.list()));

  app.post("/api/chat", async (req, res) => {
    const body = chatBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Send { sessionId, message } with a message of 1 to 4000 characters." });
      return;
    }
    const { send, signal } = eventStream(res);
    await runTurn(mem, body.data, send, signal);
    res.end();
  });

  // Demo history for a new install. One run at a time, and only once.
  let demoRunning = false;
  app.post("/api/demo", async (_req, res) => {
    if (demoRunning || hasDemo(mem)) {
      res.status(409).json({ error: demoRunning ? "The demo history is already being added." : "The demo history is already in memory." });
      return;
    }
    demoRunning = true;
    try {
      const { send, signal } = eventStream(res);
      const saved = await addDemoHistory(mem, (p) => send({ type: "demo", ...p }), signal);
      send({ type: "done", saved });
      res.end();
    } finally {
      demoRunning = false;
    }
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "No such endpoint." }));
  // Malformed JSON, a body over the limit, or anything unexpected: a short JSON error, never a stack trace.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("[http]", err);
    res.status(status).json({ error: status === 413 ? "The request is too large." : status === 400 ? "The request body is not valid JSON." : "Something went wrong on the server." });
  };
  app.use(onError);
  return app;
}

/**
 * Listen on `port`; if it is taken, try the next ones rather than failing. Loopback only: there are
 * no accounts, so anyone who could reach the port could read the memory and spend the API keys.
 */
export function listen(app: ReturnType<typeof createApp>, port: number, triesLeft = 10): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && triesLeft > 0) {
        console.log(`  port ${port} is in use, trying ${port + 1}`);
        resolve(listen(app, port + 1, triesLeft - 1));
      } else reject(e);
    });
  });
}
