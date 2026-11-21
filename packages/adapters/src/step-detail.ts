import path from "node:path";
import { commandWords, normalizedCommand } from "./command-policy";
import { commandOf } from "./machine-protocol";
import { KEY_SHAPES, SIGNED_SHAPES } from "./outbound-url";
import { maskValuesAfter, redactCommon } from "./redact";

/**
 * The short, masked label of what a tool call works on (`agent.tool`'s `detail`, a computer brain's step line): shared
 * by the engine, which labels its own tools' calls, and the runner, which labels a computer brain's own (a connector's
 * tools never show their input).
 */

const MAX = 80;

/** One line of at most `MAX` characters (cut with "…"); undefined for anything but a non-empty string. */
export function shortLine(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
}

/** "https://shop.example/checkout?token=…" → "shop.example/checkout". */
export function siteOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^https?:\/\/([^/?#\s]+)([^?#\s]*)/i.exec(v.trim());
  if (!m) return undefined;
  const host = (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase();
  const path = (m[2] ?? "").replace(/\/$/, "");
  return shortLine(`${host}${path}`);
}

/** Things that look like credentials, masked in previews and live output (agents should never have any). */
export const SECRET = new RegExp(`${KEY_SHAPES.source}|${SIGNED_SHAPES.source}`, "g");

export const maskSecrets = (text: string) => text.replace(SECRET, "••••");

export const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** `maskSecrets`, private keys too (from their first line on): text people read that must hold none. */
export const maskCredentials = (text: string) => maskSecrets(text).replace(PRIVATE_KEY_BLOCK, "••••");

/**
 * An address's user and password (`postgres://user:pass@host`), found from its `://` with its scheme checked behind
 * it. Looked for from each letter a scheme could start at, one long word of dots or dashes costs the square of its
 * length.
 */
const USERINFO = /:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@'"]+@/gi;
/** In a list of arguments kept as text, what stands between one and the next (`","`), up to the next one's quote. */
const NEXT_ARGUMENT = String.raw`\\*["']\s*,\s*`;
/**
 * The value after an option named for a secret (`--password hunter2`, `--api-key k`), a quoted one whole, also where
 * its quotes are written with backslashes: the option may open a quoted command (`sh -c "--token …"`), and a command
 * kept in JSON has its quotes written so. In a list of arguments kept as text, the value is the next one
 * (`"--password","…"`). Never a number after a name in the plural, which sets a count (`--max-tokens 4096`), also
 * with what closes or ends its command right after it (`$(llm --max-tokens 4096)`, `--max-tokens 4096; echo`).
 *
 * The first lookahead lets an option through only where a value follows its name. Without it, in one long word after
 * `--` every `token` is tried as the name's last and the rest of the word read again: the square of its length.
 */
const SECRET_OPTION = new RegExp(
  String.raw`(?<![^\s"'])(?=--?[\w-]+(?:\s+[^\s-]|${NEXT_ARGUMENT}\\*["'][^-]))--?(?![\w-]*s(?:\s+|${NEXT_ARGUMENT}\\*["'])\d+[)\]};|&<>,.]*(?![^\s"'\\]))[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*(?:\s+|${NEXT_ARGUMENT}(?=\\*["']))(?=[^\s-])`,
  "gi",
);

/**
 * `maskCredentials`, an address's user and password (`postgres://***@host`, first: `redactCommon` would read a
 * `token:` there as a value to mask up to the next space), the shapes `redactCommon` knows (bearer headers,
 * `token=` values) and the value after a secret-named option (`--password ***`): text that leaves its place.
 */
export const redactCredentials = (text: string) =>
  maskValuesAfter(redactCommon(maskCredentials(text).replace(USERINFO, "://***@")), SECRET_OPTION);

/** Parts of a command line that only set up the next one (`cd repo && npm test`). */
const SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset"]);
/** Where a command's own words end: an option or a redirection. */
const OPTION = /^-|[<>]/;
/** A path or a web address: the only word after an option that can be a command's main argument. */
const PLACE = /^(?:\.{0,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/)/i;

/**
 * A command line, credentials already masked, in a few words: its first program (past `cd` and the like, wrappers
 * and env assignments left out) and its main argument, the words before its first option ("npm run build", "git
 * commit"), else its first path or web address ("rm /etc/x", "curl api.example.com/v1"). Never another word after
 * an option, which could be that option's value; a web address keeps its site and path only.
 */
export function commandGist(masked: string): string | undefined {
  for (const argv of commandWords(masked)) {
    const start = argv.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (start < 0) continue;
    const [program = "", ...rest] = normalizedCommand(argv.slice(start)).split(" ");
    if (!program || SETUP.has(program)) continue;
    const options = rest.findIndex((w) => OPTION.test(w));
    const lead = rest.slice(0, Math.min(options < 0 ? rest.length : options, 2));
    const args = lead.length > 0 ? lead : rest.filter((w) => PLACE.test(w)).slice(0, 1);
    return [program, ...args].map((w) => siteOf(w) ?? w).join(" ");
  }
  return undefined;
}

/** A command's label: Claude Code's own one-line `description` of it, else the command in a few words. */
export function commandLabel(command: string, description: unknown): string | undefined {
  const said = typeof description === "string" ? shortLine(redactCredentials(description)) : "";
  return said || shortLine(commandGist(redactCredentials(command)));
}

/** `Tool` names are Claude Code's own: a file tool's input names its file under one of these. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** A path as the agent's folder sees it: inside it, relative; anywhere else, only its last part (people's folders). */
export function pathIn(folder: string, file: string): string {
  const slashed = (p: string) => p.replace(/\\/g, "/");
  const home = path.posix.normalize(slashed(folder)).replace(/\/+$/, "");
  const flat = slashed(file);
  const rooted = /^(?:\/|~|[A-Za-z]:)/.test(flat);
  // Read as it resolves: "/folder/../../etc/x" is outside the folder, never shown as "../../etc/x".
  const resolved = path.posix.normalize(rooted || !home ? flat : `${home}/${flat}`);
  if (home && resolved.startsWith(`${home}/`)) return resolved.slice(home.length + 1);
  // Past the folder (rooted, or climbed out of it): only the last part. A relative path with no folder to compare stays.
  const out = rooted || home || resolved === ".." || resolved.startsWith("../");
  return out
    ? (resolved
        .split("/")
        .filter((p) => p && p !== "..")
        .at(-1) ?? "")
    : resolved;
}

/**
 * What a computer brain's own call (Claude Code's Read, Bash, WebFetch…) works on, in a few words for the step line:
 * a file's path in the agent's folder, a search's pattern, a command's description, a site, a query, a subtask's
 * description. Credentials masked and cut short (`shortLine`); never a file's content, and nothing for a tool this
 * doesn't name, a connector's (`mcp__…`) above all.
 */
export function ownToolDetail(
  name: string,
  input: Record<string, unknown> | null | undefined,
  folder = "",
): string | undefined {
  const i = input ?? {};
  const mask = (v: unknown) => (typeof v === "string" ? shortLine(redactCredentials(v)) : undefined);
  const field = Object.hasOwn(FILE_TOOLS, name) ? FILE_TOOLS[name] : undefined;
  if (field) return mask(typeof i[field] === "string" ? pathIn(folder, i[field] as string) : undefined);
  switch (name) {
    case "Grep":
    case "Glob":
      return mask(i.pattern);
    case "Bash":
      return commandLabel(commandOf("Bash", i), i.description);
    case "WebFetch": {
      const site = siteOf(i.url);
      return site ? shortLine(redactCredentials(site)) : undefined;
    }
    case "WebSearch":
      return mask(i.query);
    case "Task":
    case "Agent":
      return mask(i.description);
    default:
      return undefined;
  }
}
