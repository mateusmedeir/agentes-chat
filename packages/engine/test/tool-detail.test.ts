import { expect, test } from "bun:test";
import { stepDetail, toolDetail } from "../src/tool-detail";

const key = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";

test("a web search shows its term, a context search never does", () => {
  expect(toolDetail("web_search", { query: "bun test coverage" })).toBe("bun test coverage");
  expect(toolDetail("search_context", { query: "the launch plan" })).toBeUndefined();
  expect(toolDetail("web_search", { query: `why ${key} fails` })).toBe("why •••• fails");
  expect(toolDetail("web_search", { query: "  " })).toBeUndefined();
  expect(toolDetail("web_search", {})).toBeUndefined();
});

test("a web fetch shows its site and path, never the query string or the credentials in the address", () => {
  expect(toolDetail("web_fetch", { url: "https://docs.example.com/guide/a?token=abc123&x=1#top" })).toBe(
    "docs.example.com/guide/a",
  );
  expect(toolDetail("web_fetch", { url: "https://ana:hunter2@docs.example.com/a" })).toBe("docs.example.com/a");
  expect(toolDetail("web_fetch", { url: "not an address" })).toBeUndefined();
});

test("run_code shows only its language: a line of its code can hold a value no mask knows", () => {
  expect(toolDetail("run_code", { language: "python", code: 'db = "valor"\nprint(1)' })).toBe("python");
  expect(toolDetail("run_code", { language: "bash", code: `curl -H "x: ${key}" https://x.test` })).toBe("bash");
  expect(toolDetail("run_code", { language: "python" })).toBe("python");
});

test("the detail a computer brain's runner sent is masked and cut again here", () => {
  expect(stepDetail("src/x.ts")).toBe("src/x.ts");
  expect(stepDetail(`deploy ${key}`)).toBe("deploy ••••");
  expect(stepDetail("x".repeat(500))?.length).toBe(80);
  expect(stepDetail(undefined)).toBeUndefined();
  expect(stepDetail("   ")).toBeUndefined();
});

test("what a tool of a connector sends never shows", () => {
  expect(toolDetail("github_create_issue", { title: "Bug", query: "q", url: "https://x.test/a" })).toBeUndefined();
});
