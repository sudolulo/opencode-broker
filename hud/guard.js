// Is opencode-guard (the permission-mode plugin) present on this machine?
//
// The HUD shows three things that only mean something when opencode-guard is loaded: the
// permission-mode badge (manual / edits / auto / god), the mode cycle key, and the guard
// "floor" menu. They work by writing files opencode-guard reads -- the HUD is a TUI plugin
// and the guard a server plugin, so files are the only channel between them. Without the
// guard those files are written for nobody, and a badge saying "manual" would claim a
// protection that does not exist. So the HUD hides them unless the guard looks installed.
//
// The answer comes from, in order:
//   1. OPENCODE_BROKER_HUD_GUARD=on|off               (environment override)
//   2. `hud.permissionModes: true | false` in config   (explicit setting)
//   3. detection ("auto", the default): any one of
//        - an opencode-guard / opencode-guardrails package that resolves from here or from
//          opencode's own config directory,
//        - opencode.json(c) naming it in its plugin list,
//        - a file in opencode's plugin directory named after it,
//        - the guard's own state files (the global mode flag, the per-session mode
//          directory, or the floor flag) already on disk.
// Detection errs toward SHOWING the controls: a false positive is a badge for a guard that is
// not listening, a false negative hides controls from someone who relies on them. Either is
// fixed by the explicit setting.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGES = ["opencode-guard", "opencode-guardrails"];
const NAME = /opencode-guard/;

export const detectGuard = ({
  setting = "auto",
  env = process.env,
  home = homedir(),
  configHome = env.XDG_CONFIG_HOME || join(home, ".config"),
  resolveFrom = import.meta.url,
} = {}) => {
  const override = String(env.OPENCODE_BROKER_HUD_GUARD ?? "").toLowerCase();
  if (["on", "1", "true", "yes"].includes(override)) return { present: true, reason: "OPENCODE_BROKER_HUD_GUARD" };
  if (["off", "0", "false", "no"].includes(override)) return { present: false, reason: "OPENCODE_BROKER_HUD_GUARD" };
  if (setting === true) return { present: true, reason: "hud.permissionModes" };
  if (setting === false) return { present: false, reason: "hud.permissionModes" };

  const opencodeConfig = join(configHome, "opencode");
  for (const base of [resolveFrom, join(opencodeConfig, "package.json")]) {
    try {
      const require = createRequire(base);
      for (const name of PACKAGES) {
        try {
          require.resolve(`${name}/package.json`);
          return { present: true, reason: `package ${name}` };
        } catch (error) {
          // Installed, but its exports map does not list package.json: still installed.
          if (error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return { present: true, reason: `package ${name}` };
        }
      }
    } catch {}
  }
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try {
      if (NAME.test(readFileSync(join(opencodeConfig, file), "utf8"))) return { present: true, reason: file };
    } catch {}
  }
  for (const dir of ["plugin", "plugins"]) {
    try {
      if (readdirSync(join(opencodeConfig, dir)).some((entry) => NAME.test(entry))) return { present: true, reason: `${dir}/` };
    } catch {}
  }
  for (const path of [join(opencodeConfig, "mode"), join(opencodeConfig, "autoclass"), join(home, ".local/share/opencode/modes")]) {
    if (existsSync(path)) return { present: true, reason: path };
  }
  return { present: false, reason: "not detected" };
};
