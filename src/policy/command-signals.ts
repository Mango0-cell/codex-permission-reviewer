// A bounded lexical signal detector, not a shell interpreter. Quoted arguments
// are also inspected because shells and database clients execute string arguments.
// A match only blocks approval; absence of a match never grants permission.
const SEPARATOR = /^[;|&()<>\n]$/u;

function words(text: string): string[] {
  const result = [];
  let word = "";
  let quote = null;
  const flush = () => { if (word) result.push(word); word = ""; };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\" && quote !== "'" && i + 1 < text.length) {
      if (text[i + 1] === "\n") { i += 1; continue; }
      word += text[++i]!;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (SEPARATOR.test(char)) {
      flush(); result.push(char);
    } else if (/\s/u.test(char)) {
      flush();
    } else if (char === "#" && !word) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else word += char;
  }
  flush();
  return result;
}

function recursiveRemoval(args: string[]) {
  // Options belong to rm only until --. Never take r/f from
  // filenames, a later command, or another program's --rm option.
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg === "--recursive" || /^-[^-]*[rR]/u.test(arg)) return true;
  }
  return false;
}

function destructiveGit(args: string[]) {
  // Skip global options with values before looking for a subcommand.
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(args[i]!)) i += 1;
    i += 1;
  }
  const command = args[i++];
  const options = args.slice(i, args.indexOf("--", i) < 0 ? undefined : args.indexOf("--", i));
  if (command === "push") return options.some((arg) => arg === "--force" || /^-[^-]*f/u.test(arg));
  if (command === "reset") return options.includes("--hard");
  if (command === "clean") return options.some((arg) => arg === "--force" || /^-[^-]*f/u.test(arg));
  if (command === "checkout") return args.slice(i).includes("--");
  return command === "restore" && args.length > i;
}

function broadSql(text: string) {
  // Ignore WHERE inside literals and comments, and keep its scope local to
  // the SQL statement. This is conservative signal matching, not SQL parsing.
  const sql = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/gu, " ");
  return sql.split(/;/u).some((statement) =>
    /\b(?:drop|truncate)\s+(?:table|database|schema)\b/iu.test(statement) ||
    (/\b(?:delete\s+from\s+\S+|update\s+\S+\s+set\b)/iu.test(statement) && !/\bwhere\b/iu.test(statement)));
}

export function hasNonOverridableCommandSignal(command: unknown, depth = 0): boolean {
  if (typeof command !== "string" || command.length > 12_000) return true;
  if (/\b(?:authorization|permission|credential|secret)\s+bypass\b/iu.test(command) || broadSql(command)) return true;
  const tokens = words(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (SEPARATOR.test(token)) continue;
    const name = token.slice(token.lastIndexOf("/") + 1);
    let end = i + 1;
    while (end < tokens.length && !SEPARATOR.test(tokens[end]!)) end += 1;
    const args = tokens.slice(i + 1, end);
    if (name === "rm" && recursiveRemoval(args)) return true;
    if (name === "git" && destructiveGit(args)) return true;
    if (["curl", "wget"].includes(name)) {
      let next = end;
      while (next < tokens.length && SEPARATOR.test(tokens[next]!)) next += 1;
      if (["sh", "bash", "zsh", "node", "python", "python3"].includes(tokens[next]?.split("/").at(-1) ?? "")) return true;
    }
    if (/[\s;|&]/u.test(token)) {
      // Bound nesting rather than treating deeply embedded executable text as safe.
      if (depth >= 4 || hasNonOverridableCommandSignal(token, depth + 1)) return true;
    }
  }
  return false;
}
