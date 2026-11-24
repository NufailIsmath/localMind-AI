import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HrCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

/**
 * Stand-in for the external HR leave system (provisional contract). Records
 * every call; `failNext(n, status)` makes the next n calls fail; creations
 * return { id: "HR-<n>" }.
 */
export async function startMockHr() {
  const calls: HrCall[] = [];
  const failures: number[] = [];
  const seenKeys = new Set<string>();
  let nextId = 1;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
    const fail = failures.shift();
    if (fail) {
      res.writeHead(fail, { "content-type": "application/json" }).end(JSON.stringify({ error: `simulated ${fail}` }));
      return;
    }
    const key = String(req.headers["idempotency-key"] ?? "");
    const duplicate = seenKeys.has(key);
    seenKeys.add(key);
    res.writeHead(duplicate ? 200 : 201, { "content-type": "application/json" });
    const creates = req.url === "/v1/leave-requests" || req.url === "/v1/leave-records";
    res.end(JSON.stringify(creates ? { id: `HR-${duplicate ? nextId - 1 : nextId++}` } : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    failNext: (n: number, status = 503) => failures.push(...Array(n).fill(status)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
