import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addRunStep,
  decideProposal,
  enabledSkills,
  insertMessage,
  linkRunActions,
  SKILL_CREATE_LIMITS,
  saveSkill,
  type ToolContext,
  undoAgentAction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A run of the agent answering the owner's message in general. */
async function personRun(fx: Fixture) {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "@dev transforma isso numa skill",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

type Run = Awaited<ReturnType<typeof personRun>>;

async function invoke(run: Run, name: string, input: Record<string, unknown>) {
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.triggerMessageId,
    triggerMessageId: run.triggerMessageId,
  };
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

const skill = (name: string) => ({
  name,
  description: "When publishing the weekly report.",
  body: "# Weekly report\n1. Pull the numbers.\n2. Post them in #reports.\n\n## Pitfalls\n- Mondays only.",
});

describe("an agent makes a skill when a person asks (ADR 0120, addendum of 2026-11-14)", () => {
  test("the skill is the agent's own, on for it at once, with a receipt whose Desfazer archives it", async () => {
    f = await setup({ skillTools: true });
    const run = await personRun(f);
    const out = await invoke(run, "create_skill", skill("weekly-report"));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Created the skill weekly-report");

    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(row).toMatchObject({ origin: "agent", ownerAgentId: f.agent.id, source: "manual", version: 1 });
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual(["weekly-report"]);

    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
      body: "Done",
    });
    await linkRunActions(f.db, f.org.id, run.id, reply.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [reply.id])).get(reply.id) ?? [];
    expect(receipt).toMatchObject({ kind: "skill.created", params: { name: "weekly-report", asked: true } });

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const [gone] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(gone?.deletedAt).not.toBeNull();
    expect(await enabledSkills(f.db, f.org.id, f.agent.id)).toEqual([]);
  });

  test("refused for a name already here, with a credential, and past the run's limit", async () => {
    f = await setup({ skillTools: true });
    await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name: "deploy",
      description: "Before any deploy.",
      body: "# deploy",
      metadata: {},
      source: "manual",
    });

    const run = await personRun(f);
    const taken = await invoke(run, "create_skill", skill("deploy"));
    expect(taken.isError).toBe(true);
    expect(taken.content).toContain("already exists");

    const secret = await invoke(run, "create_skill", {
      ...skill("with-key"),
      body: "Use the key sk-test-00000000000000000000",
    });
    expect(secret.isError).toBe(true);
    expect(secret.content).toContain("credential");

    for (let i = 0; i < SKILL_CREATE_LIMITS.perRun; i++)
      expect((await invoke(run, "create_skill", skill(`report-${i}`))).isError).toBeFalsy();
    const past = await invoke(run, "create_skill", skill("one-more"));
    expect(past.isError).toBe(true);
    const made = await f.db.select().from(schema.skills).where(eq(schema.skills.origin, "agent"));
    expect(made.map((s) => s.name).sort()).toEqual(["report-0", "report-1"]);
  });

  /** A person's run that read a page first: its trust is low, so what it makes waits for a card. */
  async function outsideRun(fx: Fixture) {
    const read = await personRun(fx);
    const toolUseId = `tu_${crypto.randomUUID()}`;
    await addRunStep(fx.db, read, "tool_call", { toolUseId, name: "web_fetch", input: { url: "https://example.com" } });
    await addRunStep(fx.db, read, "tool_result", { toolUseId, name: "web_fetch", content: "page", isError: false });
    return read;
  }

  const waiting = () => f.db.select().from(schema.contextProposals).where(eq(schema.contextProposals.target, "skill"));

  test("after outside content it is a proposal: nothing is made until a person accepts, and then it is the agent's", async () => {
    f = await setup({ skillTools: true });
    const read = await outsideRun(f);
    const out = await invoke(read, "create_skill", skill("weekly-report"));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("proposal");
    expect(await f.db.select().from(schema.skills)).toEqual([]);

    const [p] = await waiting();
    expect(p).toMatchObject({
      status: "pending",
      agentId: f.agent.id,
      proposedByAgentId: f.agent.id,
      skillPath: null,
      access: [{ id: "", label: "weekly-report", on: true }],
    });
    expect(p?.proposedText).toContain("name: weekly-report");
    expect(p?.proposedText).toContain("# Weekly report");

    // The same request again is the same card, not a second one.
    await invoke(read, "create_skill", skill("weekly-report"));
    expect(await waiting()).toHaveLength(1);

    // The reply that shows the card, as the run posts it at its end; someone else than the requester decides.
    const card = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: read.id, hop: 1 },
      body: "Proposed",
      meta: {
        memoryUpdates: [
          { action: "proposed", itemId: p?.id, text: "weekly-report", proposalId: p?.id, proposalIds: [p?.id] },
        ],
      },
    });
    const approver = await addMember(f.db, f.org.id, "admin");
    await decideProposal(f.db, approver.id, f.org.id, p?.id ?? "", "accept", {});
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(row).toMatchObject({
      origin: "agent",
      ownerAgentId: f.agent.id,
      ownerUserId: null,
      source: "manual",
      description: "When publishing the weekly report.",
    });
    expect(row?.body).toContain("2. Post them in #reports.");
    expect((await enabledSkills(f.db, f.org.id, f.agent.id)).map((s) => s.name)).toEqual(["weekly-report"]);

    // The receipt sits under the card and names who asked (the owner), not who approved.
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({ kind: "skill.created", params: { name: "weekly-report", asked: true } });
    const [stored] = await f.db
      .select()
      .from(schema.agentActions)
      .where(eq(schema.agentActions.id, receipt?.id ?? ""));
    expect(stored).toMatchObject({ runId: read.id, messageId: card.id, requestedByUserId: f.owner.id });

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const [gone] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "weekly-report"));
    expect(gone?.deletedAt).not.toBeNull();
    expect(await enabledSkills(f.db, f.org.id, f.agent.id)).toEqual([]);
  });

  test("a name taken before the accept makes the card stale and creates nothing", async () => {
    f = await setup({ skillTools: true });
    const out = await invoke(await outsideRun(f), "create_skill", skill("weekly-report"));
    expect(out.isError).toBeFalsy();
    await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name: "weekly-report",
      description: "Someone made it first.",
      body: "# mine",
      metadata: {},
      source: "manual",
    });
    const [p] = await waiting();
    await expect(decideProposal(f.db, f.owner.id, f.org.id, p?.id ?? "", "accept", {})).rejects.toThrow();
    const [after] = await waiting();
    expect(after?.status).toBe("stale");
    expect((await f.db.select().from(schema.skills)).map((s) => s.description)).toEqual(["Someone made it first."]);
  });

  test("outside content still refuses a credential and a name already here", async () => {
    f = await setup({ skillTools: true });
    await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
      name: "deploy",
      description: "Before any deploy.",
      body: "# deploy",
      metadata: {},
      source: "manual",
    });
    const read = await outsideRun(f);
    const taken = await invoke(read, "create_skill", skill("deploy"));
    expect(taken.isError).toBe(true);
    expect(taken.content).toContain("already exists");
    const secret = await invoke(read, "create_skill", {
      ...skill("with-key"),
      body: "Use the key sk-test-00000000000000000000",
    });
    expect(secret.isError).toBe(true);
    expect(secret.content).toContain("credential");
    expect(await waiting()).toEqual([]);
  });

  test("waiting proposals count toward the run's limit", async () => {
    f = await setup({ skillTools: true });
    const read = await outsideRun(f);
    for (let i = 0; i < SKILL_CREATE_LIMITS.perRun; i++)
      expect((await invoke(read, "create_skill", skill(`report-${i}`))).isError).toBeFalsy();
    const past = await invoke(read, "create_skill", skill("one-more"));
    expect(past.isError).toBe(true);
    expect(await waiting()).toHaveLength(SKILL_CREATE_LIMITS.perRun);
  });

  test("proposals left waiting before this run do not block a clean run from making a skill", async () => {
    f = await setup({ skillTools: true });
    const read = await outsideRun(f);
    for (let i = 0; i < SKILL_CREATE_LIMITS.perRun; i++) await invoke(read, "create_skill", skill(`old-${i}`));
    expect(await waiting()).toHaveLength(SKILL_CREATE_LIMITS.perRun);
    await f.db
      .update(schema.contextProposals)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(schema.contextProposals.target, "skill"));

    const out = await invoke(await personRun(f), "create_skill", skill("weekly-report"));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Created the skill weekly-report");
  });

  test("another run's waiting proposals do not count against this run, even one that started earlier", async () => {
    f = await setup({ skillTools: true });
    const a = await personRun(f);
    const b = await outsideRun(f);
    for (let i = 0; i < SKILL_CREATE_LIMITS.perRun; i++)
      expect((await invoke(b, "create_skill", skill(`from-b-${i}`))).isError).toBeFalsy();
    expect(await waiting()).toHaveLength(SKILL_CREATE_LIMITS.perRun);

    const out = await invoke(a, "create_skill", skill("from-a"));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Created the skill from-a");
  });

  test("waiting proposals count toward the day only inside the last 24 hours", async () => {
    f = await setup({ skillTools: true });
    // perDay proposals, spread over runs that each stay under the run's limit.
    for (let i = 0; i < SKILL_CREATE_LIMITS.perDay; i += SKILL_CREATE_LIMITS.perRun) {
      const read = await outsideRun(f);
      for (let j = 0; j < SKILL_CREATE_LIMITS.perRun; j++) await invoke(read, "create_skill", skill(`day-${i + j}`));
    }
    expect(await waiting()).toHaveLength(SKILL_CREATE_LIMITS.perDay);

    const inside = await invoke(await personRun(f), "create_skill", skill("inside"));
    expect(inside.isError).toBe(true);
    expect(inside.content).toContain("today");

    // One of them is older than a day now: there is room for a skill again.
    const [oldest] = await waiting();
    await f.db
      .update(schema.contextProposals)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(schema.contextProposals.id, oldest?.id ?? ""));
    const outside = await invoke(await personRun(f), "create_skill", skill("outside"));
    expect(outside.isError).toBeFalsy();
    expect(outside.content).toContain("Created the skill outside");
  });

  test("where skills are personal, outside content still refuses", async () => {
    f = await setup({ skillTools: true });
    await addMember(f.db, f.org.id, "member");
    const out = await invoke(await outsideRun(f), "create_skill", skill("weekly-report"));
    expect(out.isError).toBe(true);
    expect(await waiting()).toEqual([]);
    expect(await f.db.select().from(schema.skills)).toEqual([]);
  });
});
