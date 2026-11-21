import { expect, test } from "bun:test";
import { parseBrainEvent, STEP_DETAIL_MAX } from "../src/machine-protocol";
import { commandLabel, ownToolDetail } from "../src/step-detail";

const folder = "/srv/agents/ana";

test("a file tool names its file relative to the agent's folder, and a file elsewhere only by its last part", () => {
  for (const tool of ["Read", "Edit", "Write", "MultiEdit"])
    expect(ownToolDetail(tool, { file_path: `${folder}/src/x.ts` }, folder)).toBe("src/x.ts");
  expect(ownToolDetail("NotebookEdit", { notebook_path: `${folder}/n.ipynb` }, folder)).toBe("n.ipynb");
  expect(ownToolDetail("Read", { file_path: "src/y.ts" }, folder)).toBe("src/y.ts");
  expect(ownToolDetail("Read", { file_path: "/home/ada/.ssh/config" }, folder)).toBe("config");
  expect(ownToolDetail("Read", { file_path: "/home/ada/x.ts" })).toBe("x.ts");
  // Never the file's content.
  expect(ownToolDetail("Write", { file_path: "a.txt", content: "secret body" }, folder)).toBe("a.txt");
  expect(ownToolDetail("Read", {}, folder)).toBeUndefined();
});

test("a search names its pattern, a fetch its site only, a web search its term, a subtask its description", () => {
  expect(ownToolDetail("Grep", { pattern: "takeStepWords", path: "src" }, folder)).toBe("takeStepWords");
  expect(ownToolDetail("Glob", { pattern: "**/*.test.ts" }, folder)).toBe("**/*.test.ts");
  expect(ownToolDetail("WebFetch", { url: "https://docs.example.com/guide/a?token=abc123&x=1#top", prompt: "p" })).toBe(
    "docs.example.com/guide/a",
  );
  expect(ownToolDetail("WebFetch", { url: "not a url" })).toBeUndefined();
  expect(ownToolDetail("WebSearch", { query: "bun test coverage" })).toBe("bun test coverage");
  expect(ownToolDetail("Task", { description: "Find the callers", prompt: "long prompt" })).toBe("Find the callers");
  expect(ownToolDetail("Agent", { description: "Review the diff" })).toBe("Review the diff");
});

test("a command is Claude Code's own description of it, else the command in a few words", () => {
  expect(ownToolDetail("Bash", { command: "bun install --frozen-lockfile", description: "Instala dependências" })).toBe(
    "Instala dependências",
  );
  expect(ownToolDetail("Bash", { command: "cd /srv/app && npm run build --silent" })).toBe("npm run build");
  expect(ownToolDetail("Bash", { command: "   " })).toBeUndefined();
  expect(commandLabel("git commit -m x", undefined)).toBe("git commit");
});

test("every label masks credentials and stays short", () => {
  const key = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
  expect(
    ownToolDetail("Bash", { command: "curl -H 'x' https://api.example.com", description: `Calls with ${key}` }),
  ).toBe("Calls with ••••");
  expect(ownToolDetail("Bash", { command: `deploy --password hunter2 ${key}` })).not.toContain("hunter2");
  expect(ownToolDetail("WebSearch", { query: `why ${key} fails` })).toBe("why •••• fails");
  expect(ownToolDetail("Grep", { pattern: key })).toBe("••••");
  expect(ownToolDetail("Task", { description: "x".repeat(300) })?.length).toBe(80);
});

test("a connector's tool and a tool this doesn't name show nothing, whatever their input", () => {
  expect(ownToolDetail("mcp__github__create_issue", { title: "Bug", file_path: "a.ts", query: "q" })).toBeUndefined();
  expect(ownToolDetail("mcp__agentes__search_context", { query: "q" })).toBeUndefined();
  expect(ownToolDetail("TodoWrite", { todos: [] })).toBeUndefined();
  expect(ownToolDetail("Read", null)).toBeUndefined();
});

test("the wire keeps tool_started's detail cut and trimmed, and an older runner's event without it still parses", () => {
  expect(parseBrainEvent({ type: "tool_started", id: "t1", name: "Read" })).toEqual({
    type: "tool_started",
    id: "t1",
    name: "Read",
  });
  expect(parseBrainEvent({ type: "tool_started", id: "t1", name: "Read", detail: "  src/x.ts " })).toEqual({
    type: "tool_started",
    id: "t1",
    name: "Read",
    detail: "src/x.ts",
  });
  const big = parseBrainEvent({ type: "tool_started", id: "t1", name: "Read", detail: "a".repeat(5000) });
  expect(big).toMatchObject({ type: "tool_started" });
  expect((big as { detail: string }).detail.length).toBe(STEP_DETAIL_MAX);
  // Not a string, or blank: no detail, the event stands.
  expect(parseBrainEvent({ type: "tool_started", id: "t1", name: "Read", detail: 7 })).toEqual({
    type: "tool_started",
    id: "t1",
    name: "Read",
  });
  expect(parseBrainEvent({ type: "tool_started", id: "t1", name: "Read", detail: "  " })).toEqual({
    type: "tool_started",
    id: "t1",
    name: "Read",
  });
});
