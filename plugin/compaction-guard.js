// Compaction guard -- see lib/compaction-guard.js for the three defects it
// covers. Two hooks do the work:
//   experimental.session.compacting  runs after the runtime has picked a compaction
//     task and before anything is sent. A throw here cancels the compaction with no
//     request made and no summary message created (verified against v1.18.22).
//   chat.message  runs as a prompt arrives, before the loop starts. While the
//     session is idle it clears the debris a dead compaction leaves behind.
// Only the plugin factory may be exported from this file: OpenCode invokes every
// export of a plugin module as a factory.
import {
  ascendingID,
  hygieneIsEmpty,
  planCompaction,
  planHygiene,
  sessionApi,
} from "../lib/compaction-guard.js";

const sessionOf = (input) =>
  input?.sessionID ?? input?.message?.sessionID ?? input?.info?.sessionID ?? null;

export const CompactionGuard = async ({ client, directory } = {}, options = {}) => {
  const api = options?.api ?? sessionApi(client, directory);
  // Hygiene fetches the whole history, so it runs once per session per process and
  // again only after compaction activity has been seen for that session.
  const checked = new Set();
  const dirty = new Set();

  // Same split as the router: errors also reach the TUI, routine lines only the log.
  const report = (level, message) => {
    if (level === "error") console.error(`[compaction-guard] ${message}`);
    try {
      const sent = client?.app?.log?.({
        body: { service: "opencode-broker-compaction-guard", level, message },
        query: { directory },
      });
      sent?.catch?.(() => {});
    } catch {}
  };

  const hygiene = async (sessionID) => {
    if (await api.busy(sessionID)) return;
    const rows = await api.messages(sessionID);
    if (!rows) return;
    const plan = planHygiene(rows);
    if (!hygieneIsEmpty(plan)) {
      for (const item of plan.deleteMessages) await api.deleteMessage(sessionID, item.messageID);
      for (const item of plan.addCompactionParts) {
        await api.putPart({ id: ascendingID("prt"), sessionID, messageID: item.messageID, type: "compaction", auto: item.auto });
      }
      for (const item of plan.dropTasks) {
        if (item.wholeMessage) await api.deleteMessage(sessionID, item.messageID);
        else await api.deletePart(sessionID, item.messageID, item.partID);
      }
      report("warn", `${sessionID}: removed ${plan.deleteMessages.length} dead compaction summaries, ` +
        `anchored ${plan.addCompactionParts.length} orphaned summaries, ` +
        `dropped ${plan.dropTasks.length} stale compaction tasks`);
    }
    checked.add(sessionID);
    dirty.delete(sessionID);
  };

  return {
    event: async ({ event } = {}) => {
      const properties = event?.properties ?? {};
      if (event?.type === "message.updated" && properties.info?.summary === true && properties.info.sessionID) {
        dirty.add(properties.info.sessionID);
      }
      if (event?.type === "message.part.updated" && properties.part?.type === "compaction" && properties.part.sessionID) {
        dirty.add(properties.part.sessionID);
      }
      if (event?.type === "session.deleted") {
        const id = properties.info?.id ?? properties.sessionID;
        if (id) {
          checked.delete(id);
          dirty.delete(id);
        }
      }
    },

    "chat.message": async (input) => {
      const sessionID = sessionOf(input);
      if (!sessionID || (checked.has(sessionID) && !dirty.has(sessionID))) return;
      // Never block a prompt on housekeeping.
      try {
        await hygiene(sessionID);
      } catch (error) {
        report("warn", `${sessionID}: compaction hygiene skipped: ${error?.message ?? error}`);
      }
    },

    "experimental.session.compacting": async (input) => {
      const sessionID = sessionOf(input);
      if (!sessionID) return;
      let rows = null;
      try {
        rows = await api.messages(sessionID);
      } catch {}
      // Without the history there is nothing to judge, so the compaction runs as it
      // would have without this plugin.
      if (!rows) return;
      const plan = planCompaction(rows);
      if (plan.refuse) {
        dirty.add(sessionID);
        report("error", `${sessionID}: ${plan.refuse}`);
        try {
          await api.toast(plan.refuse);
        } catch {}
        throw new Error(`[compaction-guard] ${plan.refuse}`);
      }
      if (plan.repair) {
        try {
          await api.putPart({ id: ascendingID("prt"), type: "compaction", ...plan.repair });
          report("warn", `${sessionID}: resumed compaction would have been orphaned; anchored it to ${plan.repair.messageID}`);
        } catch (error) {
          report("error", `${sessionID}: could not anchor resumed compaction: ${error?.message ?? error}`);
        }
      }
    },
  };
};
