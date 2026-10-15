// A bounded lexical signal detector, not a shell interpreter. Quoted arguments
// are also inspected because shells and database clients execute string arguments.
// A match only blocks approval; absence of a match never grants permission.
const SEPARATOR = /^[;|&()<>\n]$/u;

function words(text) {
  const result = [];
  let word = "";
  let quote = null;
  const flush = () => { if (word) result.push(word); word = ""; };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && quote !== "'" && i + 1 < text.length) {
      if (text[i + 1] === "\n") { i += 1; continue; }
      word += text[++i];
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

function recursiveRemoval(args) {
  // Options belong to rm only until --. Never take r/f from
  // filenames, a later command, or another program's --rm option.
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg === "--recursive" || /^-[^-]*[rR]/u.test(arg)) return true;
  }
  return false;
}

function destructiveGit(args) {
  // Skip global options with values before looking for a subcommand.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(args[i])) i += 1;
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

function sqlWithoutCommentsAndLiterals(text) {
  return text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/gu, " ");
}

function broadSql(text) {
  // Ignore WHERE inside literals and comments, and keep its scope local to
  // the SQL statement. This is conservative signal matching, not SQL parsing.
  const sql = sqlWithoutCommentsAndLiterals(text);
  return sql.split(/;/u).some((statement) =>
    /\b(?:drop|truncate)\s+(?:table|database|schema)\b/iu.test(statement) ||
    (/\b(?:delete\s+from\s+\S+|update\s+\S+\s+set\b)/iu.test(statement) && !/\bwhere\b/iu.test(statement)));
}

function hasRowMutationSql(text) {
  const sql = sqlWithoutCommentsAndLiterals(text);
  return sql.split(/;/u).some((statement) =>
    /\bdelete\s+from\b/iu.test(statement) ||
    /\bupdate\b[\s\S]*?\bset\b/iu.test(statement) ||
    /\b(?:insert|replace|merge)\s+into\b/iu.test(statement));
}

function startsSqlReadQuery(text) {
  const withoutLeadingComments = text.replace(/^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))*/u, "");
  return /^\s*(?:select|with)\b/iu.test(withoutLeadingComments);
}

const FIND_VALUE_OPTIONS = new Set([
  "-name", "-iname", "-path", "-ipath", "-lname", "-ilname", "-regex", "-iregex",
  "-type", "-xtype", "-perm", "-user", "-group", "-size", "-links", "-inum",
  "-samefile", "-newer", "-newermt", "-uid", "-gid", "-fstype", "-context",
  "-maxdepth", "-mindepth",
]);

function findDeletes(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (FIND_VALUE_OPTIONS.has(args[i])) {
      i += 1;
      continue;
    }
    if (args[i] === "-delete") return true;
  }
  return false;
}

function hasFileDeletionTarget(args) {
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith("-") && arg !== "-") {
      if (arg === "--help" || arg === "--version") return false;
      continue;
    }
    return true;
  }
  return false;
}

const COMMAND_BOUNDARY = new Set([";", "|", "&", "\n"]);

/**
 * Detect common file and row-mutation commands that must not receive a
 * reusable learned approval. This is intentionally lexical and conservative;
 * absence of a match never authorizes an action.
 */
export function hasUnlearnableCommandMutation(command, depth = 0) {
  if (typeof command !== "string") return false;
  if (command.length > 12_000) return true;
  if (hasRowMutationSql(command)) return true;
  if (startsSqlReadQuery(command)) return false;

  const tokens = words(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (SEPARATOR.test(token)) continue;
    const name = token.slice(token.lastIndexOf("/") + 1);
    let end = i + 1;
    while (end < tokens.length && !COMMAND_BOUNDARY.has(tokens[end])) end += 1;
    const args = tokens.slice(i + 1, end);

    if (["rm", "unlink", "rmdir"].includes(name) && hasFileDeletionTarget(args)) return true;
    if (name === "find" && findDeletes(args)) return true;
    if (/[\s;|&]/u.test(token)) {
      // Reuse the bounded tokenizer for shell strings and nested command text.
      if (depth >= 4 || hasUnlearnableCommandMutation(token, depth + 1)) return true;
    }
  }
  return false;
}

export function hasNonOverridableCommandSignal(command, depth = 0) {
  if (typeof command !== "string" || command.length > 12_000) return true;
  if (/\b(?:authorization|permission|credential|secret)\s+bypass\b/iu.test(command) || broadSql(command)) return true;
  const tokens = words(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (SEPARATOR.test(token)) continue;
    const name = token.slice(token.lastIndexOf("/") + 1);
    let end = i + 1;
    while (end < tokens.length && !SEPARATOR.test(tokens[end])) end += 1;
    const args = tokens.slice(i + 1, end);
    if (name === "rm" && recursiveRemoval(args)) return true;
    if (name === "git" && destructiveGit(args)) return true;
    if (["curl", "wget"].includes(name)) {
      let next = end;
      while (next < tokens.length && SEPARATOR.test(tokens[next])) next += 1;
      if (["sh", "bash", "zsh", "node", "python", "python3"].includes(tokens[next]?.split("/").at(-1))) return true;
    }
    if (/[\s;|&]/u.test(token)) {
      // Bound nesting rather than treating deeply embedded executable text as safe.
      if (depth >= 4 || hasNonOverridableCommandSignal(token, depth + 1)) return true;
    }
  }
  return false;
}
