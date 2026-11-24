import type { ChatResponse, GroupDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";
import { principal } from "../helpers/access.js";

const IT_GUIDE = `IT Support Guide. If your laptop is not working, first restart it and check it is charging. If it still is not working, raise a ticket on the IT helpdesk portal with your asset tag. If you cannot work at all, ask IT Support for a loaner laptop.`;

describe.runIf(infraReady)("CL Buddy as a work buddy", () => {
  let h: Harness;
  let admin: string;
  let sam: { token: string; id: string };

  beforeAll(async () => {
    h = await createHarness();
    admin = (await h.register("admin@corp.test")).token;
    const hr = await h.register("people@corp.test");
    const it = await h.register("helpdesk@corp.test");
    const s = await h.register("sam@corp.test");
    sam = { token: s.token, id: s.user.id };
    const mk = async (name: string, description: string) =>
      (await h.app.inject({ method: "POST", url: "/api/admin/groups", headers: auth(admin), payload: { name, description } })).json<GroupDto>().id;
    const hrId = await mk("HR", "Leave, payroll, salary questions, benefits, expenses");
    const itId = await mk("IT Support", "Laptops, hardware, accounts, passwords, software requests");
    const engId = await mk("Engineering", "Product development and code reviews");
    for (const [id, groupIds] of [[hr.user.id, [hrId]], [it.user.id, [itId]], [s.user.id, [engId]]] as const) {
      await h.app.inject({ method: "PATCH", url: `/api/admin/users/${id}`, headers: auth(admin), payload: { groupIds } });
    }
    await h.upload(it.token, "it-guide.txt", IT_GUIDE, { visibility: "ORGANIZATION" });
    await h.waitForIndexing();
  });
  afterAll(() => h?.close());

  const chat = async (message: string) =>
    (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(sam.token), payload: { message } })).json<ChatResponse>();

  it("find_team routes topics to the right team and contacts", async () => {
    const run = (query?: string) =>
      h.app.services.tools.execute("find_team", query === undefined ? {} : { query }, {
        userId: sam.id,
        userRole: "USER",
        principal: principal(sam.id),
        conversationId: "x",
        signal: new AbortController().signal,
        addSources: () => [],
        addRestricted: () => [],
      });
    const laptop = await run("my laptop is broken");
    expect(laptop).toMatchObject({ status: "SUCCESS", output: { teams: [{ team: "IT Support", contacts: ["helpdesk@corp.test"] }] } });
    const payroll = await run("payroll question");
    expect((payroll as { output: { teams: { team: string }[] } }).output.teams[0]!.team).toBe("HR");
    const none = (await run("quantum teleportation")) as { output: { teams: unknown[]; allTeams: unknown[] } };
    expect(none.output.teams).toEqual([]);
    expect(none.output.allTeams).toHaveLength(3);
    expect(((await run()) as { output: { teams: unknown[] } }).output.teams).toHaveLength(3);
  });

  it("drafts an email addressed to the right team — using real contacts, never invented ones", async () => {
    const res = await chat("Draft an email to HR asking for annual leave from 2 to 6 March");
    expect(res.toolExecutions[0]).toMatchObject({ tool: "find_team", arguments: { query: "HR" }, status: "SUCCESS" });
    expect(res.answer).toContain("```email");
    expect(res.answer).toContain("To: people@corp.test");
    expect(res.answer).toContain("Subject: Annual leave from 2 to 6 March");
    const noTeam = await chat("Write an email asking for feedback on my presentation");
    expect(noTeam.answer).toMatch(/^To: *$/m);
  });

  it("guides someone through sorting out an issue, grounded in company documents", async () => {
    const res = await chat("My laptop isn't working, what should I do?");
    expect(res.toolExecutions[0]!.tool).toBe("search_knowledge");
    expect(res.answer).toContain("Here's what to do");
    expect(res.answer).toMatch(/1\. .*\[S1\]/);
    expect(res.answer).toMatch(/draft the email/);
    expect(res.sources[0]!.fileName).toBe("it-guide.txt");
  });

  it("gives the model the user's context (email and teams) from the session", async () => {
    const n = h.fake.requests.length;
    await chat("hello");
    const system = (h.fake.requests.slice(n).find((r) => r.path === "/api/chat")!.body as { messages: { role: string; content: string }[] }).messages[0]!;
    expect(system.content).toContain("sam@corp.test, who is in Engineering");
  });

  it("lets admins describe what a team handles (audited); others can't", async () => {
    const groups = (await h.app.inject({ method: "GET", url: "/api/admin/groups", headers: auth(admin) })).json<GroupDto[]>();
    const eng = groups.find((g) => g.name === "Engineering")!;
    const res = await h.app.inject({ method: "PATCH", url: `/api/admin/groups/${eng.id}`, headers: auth(admin), payload: { description: "Product, code reviews, on-call" } });
    expect(res.json<GroupDto>().description).toBe("Product, code reviews, on-call");
    expect((await h.app.inject({ method: "PATCH", url: `/api/admin/groups/${eng.id}`, headers: auth(sam.token), payload: { description: "x" } })).statusCode).toBe(403);
    const audit = (await h.app.inject({ method: "GET", url: "/api/admin/audit", headers: auth(admin) })).json<{ action: string }[]>();
    expect(audit.map((e) => e.action)).toContain("group.updated");
  });
});
