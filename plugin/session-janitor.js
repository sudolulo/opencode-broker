// The session janitor plugin: deletes the child sessions native `task` delegation creates,
// once it can prove each one is finished and idle. The protocol lives in
// lib/session-janitor.js; this file only wires opencode's hooks to it.
//
// Only the plugin factory may be exported from this file: opencode calls EVERY export of a
// plugin module as a factory.
//
// ☠️ Do not load this beside opencode-agent-workflows, which carries the same janitor. Two
// janitors with separate registries both retire the same children; point
// OPENCODE_SESSION_JANITOR_DIR at the other registry if both must run.
import { backgroundTaskResult, createChildManager, nativeTaskState, taskChildFromAfter } from "../lib/session-janitor.js";

export const SessionJanitor = async ({ client, directory } = {}, options = {}) => {
  const manager = options.manager ?? createChildManager({ client, directory, waitIdle: options.waitIdle });
  // Startup recovery runs in the background: children interrupted by a crash or a quit are
  // retired once their owner is gone and their terminal task part is on record. A live hook
  // never waits on it.
  Promise.resolve().then(() => manager.reconcile()).catch((error) => {
    console.error(`session-janitor: startup recovery failed: ${String(error?.message ?? error)}`);
  });
  return {
    // The after hook is terminal INTENT, not ownership: the persisted task part remains the
    // only source permitted to register a native child.
    "tool.execute.after": async (input, output) => {
      try {
        const child = taskChildFromAfter(input, output);
        if (child) await manager.terminalIntent(child);
      } catch (error) {
        console.error(`session-janitor: ${String(error?.message ?? error)}`);
      }
    },
    event: async ({ event }) => {
      try {
        const task = nativeTaskState(event);
        if (task) {
          const record = await manager.register({ ...task, source: "native-task" });
          if (record && task.mode === "foreground") {
            if (task.status === "error" || manager.consumeTerminalIntent(task.sessionID, task.parentSessionID)) {
              await manager.retireForeground(task.sessionID, task.parentSessionID);
            }
          }
        }
        // A background child retires only on opencode's exact synthetic terminal result,
        // never on session.idle.
        const terminal = backgroundTaskResult(event);
        if (terminal) await manager.retireBackground(terminal.sessionID, terminal.parentSessionID);
        if (event?.type === "session.deleted") {
          const sessionID = event.properties?.sessionID;
          const infoID = event.properties?.info?.id;
          if (!infoID || infoID === sessionID) manager.deleted(sessionID);
        }
      } catch (error) {
        console.error(`session-janitor: ${String(error?.message ?? error)}`);
      }
    },
  };
};
