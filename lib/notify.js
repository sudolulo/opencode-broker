// How a configured notify command is turned into the argv that runs. Shared by the model
// watch (`watch.notifyCommand`) and the burn watch (`burnWatch.notifyCommand`), so one
// notifier script serves both.
//
// A notify command is argv, run WITHOUT a shell: nothing in it or in a message is ever
// word-split or glob-expanded. `{title}`, `{body}` and `{kind}` are replaced wherever they
// appear, including inside a word ("--title={title}"). A command that names neither
// {title} nor {body} gets the title and the body appended as its last two arguments, which
// is what a plain `notify <title> <body>` script expects.
const PLACEHOLDER = /\{(title|body|kind)\}/g;

export const notifyArgv = (argv, { title = "", body = "", kind = "" } = {}) => {
  const words = (Array.isArray(argv) ? argv : []).map(String);
  if (!words.length) return [];                 // no command configured: nothing to run
  const values = { title: String(title), body: String(body), kind: String(kind) };
  const placed = words.some((word) => word.includes("{title}") || word.includes("{body}"));
  // One pass per word, so a title that itself contains "{body}" is never expanded twice.
  const filled = words.map((word) => word.replace(PLACEHOLDER, (_, name) => values[name]));
  return placed ? filled : [...filled, values.title, values.body];
};
