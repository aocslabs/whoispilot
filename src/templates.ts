// Shared helpers for instant suggestions: what the user has typed, the user's own templates, and indentation.
// The suggestions themselves come from real open-source code (see snippets.ts). Pure module (no `vscode` import).
// In bodies, "\t" means one indentation level.

export type UserTemplates = Record<string, Record<string, string>>; // language id (or "*") -> trigger word -> body ("" = off)

// language ids that share one corpus / one set of rules
export const ALIAS: Record<string, string> = {
  javascriptreact: "javascript", typescriptreact: "typescript", shellscript: "shell", bash: "shell", zsh: "shell",
  "objective-c": "c", "objective-cpp": "cpp", scss: "css", less: "css", razor: "html", vue: "html", svelte: "html", handlebars: "html",
};
export const baseLang = (lang: string) => ALIAS[lang] ?? lang;

/** The first letters of a construct typed at the end of the line (`i`, `for`, `<t`, `display`), if any. */
export function triggerToken(lang: string, lineBefore: string): string | undefined {
  const id = baseLang(lang);
  const m = (id === "html" ? /(<\w*)$/ : id === "css" ? /^\s*([\w@-]+)$/ : /^\s*(#?\w+)$/).exec(lineBefore);
  return m?.[1];
}

export interface Match { typed: string; key: string; body: string; }

/** The user's own templates (setting `whoispilot.templates`) matching what was typed. */
export function matchUserTemplate(lang: string, lineBefore: string, user: UserTemplates = {}): Match | undefined {
  const typed = triggerToken(lang, lineBefore);
  if (!typed) return undefined;
  const mine = { ...(user["*"] ?? {}), ...(user[baseLang(lang)] ?? {}), ...(user[lang] ?? {}) };
  const hit = Object.entries(mine).find(([k, b]) => b !== "" && k.startsWith(typed));
  return hit && { typed, key: hit[0], body: hit[1] };
}

/** True when the user switched this trigger off by giving it an empty body. */
export const disabledByUser = (lang: string, key: string, user: UserTemplates = {}) =>
  [user["*"], user[baseLang(lang)], user[lang]].some((t) => t && t[key] === "");

/** Indent a body for the current line and cut off what is already typed. `unit` = one indent level ("\t" or spaces). */
export function render(m: Match, lineIndent: string, unit: string): string {
  const lines = m.body.split("\n").map((l, i) => (i ? (l === "" ? "" : lineIndent) : "") + l.replace(/^\t+/, (t) => unit.repeat(t.length)));
  const full = lines.join("\n");
  return full.toLowerCase().startsWith(m.typed.toLowerCase()) ? full.slice(m.typed.length) : full;
}
