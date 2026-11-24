import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

describe.runIf(infraReady)("auth API", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h?.close());

  it("registers the first user as ADMIN and later users as USER", async () => {
    const first = await h.register("First@Example.com");
    expect(first.user).toMatchObject({ email: "first@example.com", role: "ADMIN" });
    expect(first.token).toEqual(expect.any(String));
    expect(first.user).not.toHaveProperty("passwordHash");
    const second = await h.register();
    expect(second.user.role).toBe("USER");
  });

  it("rejects duplicate emails and invalid input", async () => {
    const dup = await h.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "first@example.com", password: "password123" } });
    expect(dup.statusCode).toBe(409);
    const bad = await h.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "nope", password: "short" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "password"]);
  });

  it("logs in with correct credentials only", async () => {
    const ok = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "FIRST@example.com", password: "password123" } });
    expect(ok.statusCode).toBe(200);
    const wrong = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "first@example.com", password: "nope-nope" } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ghost@example.com", password: "nope-nope" } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().message).toBe(wrong.json().message);

    const me = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: auth(ok.json().token) });
    expect(me.json()).toMatchObject({ email: "first@example.com" });
  });

  it("protects routes and rejects tampered tokens", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/documents" })).statusCode).toBe(401);
    const { token } = await h.register();
    const [head, body] = token.split(".");
    const forged = `${head}.${body}.invalidsignature`;
    expect((await h.app.inject({ method: "GET", url: "/api/chat", headers: auth(forged) })).statusCode).toBe(401);
    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${body}.`;
    expect((await h.app.inject({ method: "GET", url: "/api/chat", headers: auth(noneAlg) })).statusCode).toBe(401);
  });

  it("invalidates tokens of deleted users", async () => {
    const { token, user } = await h.register();
    await h.app.services.prisma.user.delete({ where: { id: user.id } });
    const res = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: auth(token) });
    expect(res.statusCode).toBe(401);
  });

  it("returns JSON 404s for unknown routes", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_FOUND");
  });
});

describe.runIf(infraReady)("auth API with registration disabled and rate limiting on", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ ALLOW_REGISTRATION: "false", RATE_LIMIT_ENABLED: "true" });
  });
  afterAll(() => h?.close());

  it("refuses sign-ups", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@b.co", password: "password123" } });
    expect(res.statusCode).toBe(403);
  });

  it("rate-limits login attempts", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.co", password: "whatever1" } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 9).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
