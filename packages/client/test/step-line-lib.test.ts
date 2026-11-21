import { expect, test } from "bun:test";
import { ptBR } from "@agenteschat/i18n";
import i18next from "i18next";
import { applyChannelEvent, emptyStreams } from "../src/index";
import { barStep, STEP_WORDS_AFTER_MS } from "../src/lib/work";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: ptBR } }, interpolation: { escapeValue: false } });
const t = i18n.t;

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const at = 1_000_000;

/** The bar's step for run r1 after these events, `ms` into its turn. */
function stepAfter(events: Record<string, unknown>[], ms: number) {
  let s = applyChannelEvent(emptyStreams, { type: "agent.thinking", ...base } as Ev, at);
  for (const e of events) s = applyChannelEvent(s, e as Ev, at);
  const run = s.runs.r1;
  if (!run) throw new Error("no run");
  // The turn's work began at `at`: what the bar counts from (`workingSince`), and where the row sits.
  return barStep(t, { ...run, startedAt: at, workingSince: at }, "pt-BR", at + ms);
}

const call = (toolUseId: string, tool: string, said?: string) => ({
  type: "agent.tool",
  ...base,
  tool,
  toolUseId,
  ...(said ? { said } : {}),
});
const ended = (toolUseId: string) => ({ type: "agent.tool", ...base, tool: null, toolUseId });

test("its own words for the call show quoted, only once the turn has gone on for a while", () => {
  const events = [call("b1", "browser_open", "Vou abrir o Play Console")];
  expect(stepAfter(events, 2000)).toBe("usando o navegador…");
  expect(stepAfter(events, STEP_WORDS_AFTER_MS)).toBe("“Vou abrir o Play Console”");
  // Still what it is on after the call ended, while it thinks about what it found.
  expect(stepAfter([...events, ended("b1")], STEP_WORDS_AFTER_MS)).toBe("“Vou abrir o Play Console”");
});

test("a new call without words of its own replaces them with its verb", () => {
  expect(stepAfter([call("b1", "browser_open", "Vou abrir o Play Console"), call("b2", "search_context")], 9000)).toBe(
    "buscando no histórico…",
  );
});

test("a computer brain's own call, which no agent.tool told, says what it did until the next one", () => {
  const read = { type: "agent.step", ...base, tool: "Read" };
  expect(stepAfter([read], 9000)).toBe("mexendo nos arquivos do PC…");
  expect(stepAfter([{ ...read, tool: "Bash", said: "Vou rodar os testes" }], 9000)).toBe("“Vou rodar os testes”");
  expect(stepAfter([read], 1000)).toBe("pensando…");
  expect(stepAfter([{ ...read, tool: "run_terminal_command" }], 9000)).toBe("rodando um comando…");
});

test("a computer brain's own call that says what it works on names it: reading, editing, searching, the command", () => {
  const own = (tool: string, detail?: string) => ({ type: "agent.step", ...base, tool, ...(detail ? { detail } : {}) });
  expect(stepAfter([own("Read", "src/x.ts")], 9000)).toBe("lendo src/x.ts…");
  expect(stepAfter([own("Edit", "src/x.ts")], 9000)).toBe("editando src/x.ts…");
  expect(stepAfter([own("MultiEdit", "src/x.ts")], 9000)).toBe("editando src/x.ts…");
  expect(stepAfter([own("file_change", "src/x.ts")], 9000)).toBe("editando src/x.ts…");
  expect(stepAfter([own("Grep", "takeStepWords")], 9000)).toBe("procurando takeStepWords…");
  expect(stepAfter([own("Glob", "**/*.ts")], 9000)).toBe("procurando **/*.ts…");
  expect(stepAfter([own("Bash", "instala dependências")], 9000)).toBe("rodando: instala dependências…");
  expect(stepAfter([own("shell", "bun test")], 9000)).toBe("rodando: bun test…");
  // A tool with no phrase of its own for it keeps its verb, and the thing follows.
  expect(stepAfter([own("WebFetch", "docs.example.com/a")], 9000)).toBe("lendo uma página da web · docs.example.com…");
  expect(stepAfter([own("WebSearch", "bun test coverage")], 9000)).toBe("pesquisando na web · bun test coverage…");
  // No detail (an older runner): the tool's verb alone, as before.
  expect(stepAfter([own("Read")], 9000)).toBe("mexendo nos arquivos do PC…");
  expect(stepAfter([own("Bash")], 9000)).toBe("rodando um comando…");
  // A long one is cut for the line.
  expect(stepAfter([own("Grep", "a".repeat(120))], 9000).length).toBeLessThan(80);
  // Its own words still come first.
  expect(stepAfter([{ ...own("Read", "src/x.ts"), said: "Vou ler" }], 9000)).toBe("“Vou ler”");
});

test("a call waiting on a person says so before any words", () => {
  const held = { type: "agent.tool", ...base, tool: null, toolUseId: "q1", held: true };
  expect(stepAfter([call("q1", "ask_user", "Vou perguntar"), held], 9000)).toBe("esperando aprovação…");
});
