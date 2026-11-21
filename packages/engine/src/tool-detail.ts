import {
  commandLabel,
  commandOf,
  errorLineOf,
  maskCredentials,
  maskSecrets,
  PERMISSION_TOOL,
  PRIVATE_KEY,
  PRIVATE_KEY_BLOCK,
  redactCredentials,
  SECRET,
  shortLine as short,
  siteOf,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { clipText } from "@agenteschat/ui/widgets/spec";

export { maskCredentials, maskSecrets, redactCredentials };

function issueRef(v: unknown) {
  const t = short(v);
  if (!t) return undefined;
  const n = /^#?(\d+)$/.exec(t);
  return n ? `#${n[1]}` : t;
}

/** A computer brain's step detail (`tool_started.detail`), as people may read it: the runner masked it, this does again. */
export const stepDetail = (detail: string | undefined) => (detail ? short(redactCredentials(detail)) : undefined);

/** What a permission check (`permission_prompt`) asks about; null when the runner asks again (`request_id` only). */
function promptAsked(i: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | null {
  const inner = i.input;
  if (typeof i.tool_name !== "string" || !i.tool_name) return null;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  return { tool: i.tool_name, input: inner as Record<string, unknown> };
}

/** The runner asking again about a command waiting on a person: no step of its own, its answer is the first ask's. */
export const promptPoll = (name: string, input: Record<string, unknown> | undefined) =>
  name === PERMISSION_TOOL && typeof input?.request_id === "string";

/** The runner telling of a call its own command policy refused (`refused`): recorded, never asked, held or judged. */
export const promptRefused = (name: string, input: Record<string, unknown> | undefined) =>
  name === PERMISSION_TOOL && typeof input?.refused === "object" && input.refused !== null;

/**
 * `permission_prompt`'s answer: `{behavior}` when decided (a `deny` says why: `message` to the agent, `code` for
 * the apps), `{status: "pending", request_id}` while a person decides.
 */
export function promptAnswer(content: string): {
  behavior?: string;
  message?: string;
  code?: string;
  status?: string;
  request_id?: string;
} {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** A permission check's label: Claude Code's own one-line description of the command, else the command in a few words. */
function promptLabel(i: Record<string, unknown>): string | undefined {
  const asked = promptAsked(i);
  if (!asked) return undefined;
  return commandLabel(commandOf(asked.tool, asked.input), asked.input.description);
}

/** The whole command a permission check (`permission_prompt`) is about, as one line, credentials masked. */
export function toolCommand(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const asked = name === PERMISSION_TOOL ? promptAsked(input ?? {}) : null;
  return asked ? redactCredentials(commandOf(asked.tool, asked.input)) || undefined : undefined;
}

/**
 * A short, safe label for the `agent.tool` event ("lendo a skill relatorio",
 * "issue #131"). Only these fields of built-in tools are ever shown: never
 * other inputs, and nothing from connector (MCP) tools.
 */
export function toolDetail(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const i = input ?? {};
  switch (name) {
    case "load_skill":
    case "browser_profile":
      return short(i.name);
    case "read_skill_file": {
      const skill = short(i.name);
      const path = typeof i.path === "string" ? i.path : "";
      return skill ? short(path ? `${skill}/${path}` : skill) : undefined;
    }
    case "create_issue":
      return short(i.title);
    case "update_issue":
    case "comment_issue":
      return issueRef(i.issue);
    case "create_artifact":
    case "create_spreadsheet":
    case "create_presentation":
    case "create_canvas":
      return short(i.title);
    case "update_artifact":
      return short(i.title);
    // What it looks up on the web or fetches: the term, or the site (never the address's query string, which can carry tokens).
    case "web_search":
      return short(redactCredentials(typeof i.query === "string" ? i.query : ""));
    case "web_fetch": {
      const site = siteOf(i.url);
      return site ? short(redactCredentials(site)) : undefined;
    }
    // Only the language: a line of the code can hold a value no mask knows (`db = "…"`).
    case "run_code":
      return short(i.language);
    case "write_file":
    case "read_file":
    case "review_media":
    case "list_files":
    case "export_file":
    case "upload_file":
      return short(i.path);
    case "run_skill_script": {
      const skill = short(i.skill);
      return skill ? short(typeof i.path === "string" ? `${skill}/${i.path}` : skill) : undefined;
    }
    // The agent browser (ADR 0040): the site it opens, never the query string (it can carry tokens).
    case "browser_open":
    case "browser_tabs":
      return siteOf(i.url);
    case PERMISSION_TOOL:
      return promptLabel(i);
    default:
      return undefined;
  }
}

/** The input naming the file each Drive tool works on: `artifact_id`, a live file's `file` (ADR 0196), a canvas. */
const FILE_FIELD: Readonly<Record<string, string>> = {
  read_artifact: "artifact_id",
  update_artifact: "artifact_id",
  share_artifact: "artifact_id",
  import_file: "artifact_id",
  read_spreadsheet: "file",
  edit_spreadsheet: "file",
  read_presentation: "file",
  edit_presentation: "file",
  read_canvas: "file",
  edit_canvas: "file",
  read_document: "file",
  edit_document: "file",
  generate_image: "canvas",
};

/** Drive tools by id: the file's title, only when it belongs to this same channel (so no title leaks elsewhere). */
export async function artifactToolDetail(
  db: Database,
  orgId: string,
  channelId: string,
  name: string,
  input: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const field = Object.hasOwn(FILE_FIELD, name) ? FILE_FIELD[name] : undefined;
  if (!field) return undefined;
  const id = input?.[field];
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [a] = await db
    .select({ title: schema.artifacts.title, channelId: schema.artifacts.channelId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.orgId, orgId), isNull(schema.artifacts.deletedAt)));
  return a && a.channelId === channelId ? short(a.title) : undefined;
}

/** `text` with each of `values` masked wherever it appears, the longest first: secrets known by value, of any shape. */
export const maskValues = (text: string, values: readonly string[]) =>
  values
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, value) => masked.replaceAll(value, "••••"), text);

/**
 * Whether a value carries a credential by its format (an API key, a token, a private key): what a run
 * nobody is behind never sends anywhere (ADR 0053 §3).
 */
export function carriesCredential(value: unknown): boolean {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return PRIVATE_KEY.test(text) || text.replace(SECRET, "") !== text;
}

/** `maskCredentials`, except a credential that appears word for word in `pasted` (what people wrote themselves). */
export const maskCredentialsExcept = (text: string, pasted: string) => {
  const keep = (found: string) => (pasted.includes(found) ? found : "••••");
  return text.replace(SECRET, keep).replace(PRIVATE_KEY_BLOCK, keep);
};

/**
 * What a CLI's sign-in holds beyond `SECRET`'s shapes (OpenAI and Anthropic keys and OAuth tokens, JWTs): Cursor keys
 * (`key_…`, `crsr_…`), xAI keys (`xai-…`), OpenAI refresh tokens (`rt.…`, `rt_…`), Google's OAuth access tokens
 * (`ya29.…`), refresh tokens (`1//…`), API keys (`AIza…`) and OAuth client secrets (`GOCSPX-…`), and every value of a
 * sign-in file's fields (Codex's `auth.json`, Claude Code's `.credentials.json`, Cursor's, OpenCode's, Grok Build's and
 * the Antigravity CLI's): `"refresh_token": "…"`, `accessToken: …`, `OPENAI_API_KEY=…`.
 */
// Codex 0.165's `auth.json` refresh token starts `rt.` (seen on a real sign-in, 2026-11-04), older ones `rt_`.
const SIGN_IN_SHAPES =
  /\b(?:key|crsr)_[A-Za-z0-9]{32,}|\bxai-[A-Za-z0-9]{20,}|\brt[._][A-Za-z0-9._-]{19,}[A-Za-z0-9_-]|\bya29\.[A-Za-z0-9_-]{20,}|(?<![\w/])1\/\/[0-9][A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}|\bGOCSPX-[A-Za-z0-9_-]{20,}/g;
const SIGN_IN_FIELD =
  /(["']?\b(?:access_?token|refresh_?token|id_?token|oauth_?token|api_?key|\w*_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)["']?\s*[:=]\s*)("[^"\s]{8,}"|'[^'\s]{8,}'|[^\s"',}]{8,})/gi;

/** The team's right hand's reply (ADR 0137 §4): every credential and sign-in in it replaced by `note`, and how many. */
export function scrubSignIns(text: string, note: string): { text: string; found: number } {
  let found = 0;
  const hit = () => {
    found++;
    return note;
  };
  const out = text
    // A value already scrubbed stays as it is, so scrubbing twice changes nothing: only when what matched is the
    // note's own start and nothing more (the note in front of a real value hides nothing).
    .replace(SIGN_IN_FIELD, (match, field: string, value: string, at: number, all: string) =>
      note.startsWith(value) && all.startsWith(note, at + field.length) ? match : `${field}${hit()}`,
    )
    .replace(PRIVATE_KEY_BLOCK, hit)
    .replace(SECRET, hit)
    .replace(SIGN_IN_SHAPES, hit);
  return { text: out, found };
}

/** An absolute path two parts deep or more (`/home/ada/x.jsonl`, `~/x/y`, `C:\Users\x`), never a URL's. */
const ABSOLUTE_PATH = /(?<![\w:/.~\\-])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/:"'()<>,;]+){2,}[\\/]?/g;

/**
 * What a command-line tool said when it failed, as anyone in the conversation may read it: a provider's JSON answer's
 * own `message`, else its last line that names an error, else its last line. No stack frames, credentials and sign-ins
 * masked, absolute paths cut to their last part (they name people's folders), one line of at most 200 characters (cut
 * at a word, with "…").
 */
export function cliErrorWords(text: string): string {
  let said = "";
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const o = JSON.parse(text.slice(json, text.lastIndexOf("}") + 1)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const message = o.error?.message ?? o.message;
      if (typeof message === "string") said = message;
    } catch {
      // Not JSON: its lines say it.
    }
  }
  if (!said) said = errorLineOf(text);
  const safe = scrubSignIns(redactCredentials(said.replace(/file:\/\//g, "")), "••••").text;
  const short = safe
    .replace(ABSOLUTE_PATH, (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
    .replace(/^(?:Uncaught )?error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clipText(short, 200);
}

export const PREVIEW_CODE_CHARS = 4096;

/** `run_code`'s code for the activity bar (≤ 4 KB, secrets masked). File tools show their path in `detail`. */
export function toolCode(
  name: string,
  input: Record<string, unknown> | undefined,
): { language: string; source: string } | undefined {
  if (name !== "run_code") return undefined;
  const i = input ?? {};
  const code = maskSecrets(typeof i.code === "string" ? i.code : "");
  return {
    language: typeof i.language === "string" ? i.language : "",
    source: code.length > PREVIEW_CODE_CHARS ? `${code.slice(0, PREVIEW_CODE_CHARS)}\n…` : code,
  };
}
