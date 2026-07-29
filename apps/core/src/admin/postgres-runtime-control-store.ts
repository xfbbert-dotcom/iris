import type pg from "pg";

import type {
  RuntimeCapabilityName,
  RuntimeControllerSnapshot,
  RuntimeControlStore,
} from "./runtime-controller.js";

type RuntimeControlRow = {
  scope: "global" | "group" | "capability";
  target_id: string;
  enabled: boolean;
};

const capabilityNames: RuntimeCapabilityName[] = [
  "readGroupContext",
  "replyWhenMentioned",
  "readGroupDocuments",
  "retrieveKnowledgeBase",
  "proactiveSpeech",
  "generateKnowledgeDrafts",
  "writeKnowledgeBase",
  "callExternalTools",
];
const capabilityNameSet = new Set<string>(capabilityNames);

export function createPostgresRuntimeControlStore(
  pool: Pick<pg.Pool, "query">,
): RuntimeControlStore {
  return {
    async load(defaultSnapshot) {
      await initializeDefaults(pool, defaultSnapshot);
      const result = await pool.query<RuntimeControlRow>(
        `select scope, target_id, enabled
from runtime_controls
order by scope asc, target_id asc`,
      );
      return snapshotFromRows(defaultSnapshot, result.rows);
    },

    async setGlobalEnabled(enabled) {
      await upsertControl(pool, "global", "global", enabled);
    },

    async setGroupEnabled(groupId, enabled) {
      if (enabled) {
        await pool.query(
          "delete from runtime_controls where scope = 'group' and target_id = $1",
          [groupId],
        );
        return;
      }
      await upsertControl(pool, "group", groupId, false);
    },

    async setCapabilities(updates) {
      const entries = Object.entries(updates) as Array<[RuntimeCapabilityName, boolean]>;
      if (entries.length === 0) {
        return;
      }
      const values: unknown[] = [];
      const rows = entries.map(([capability, enabled], index) => {
        values.push("capability", capability, enabled);
        const offset = index * 3;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
      });
      await pool.query(
        `insert into runtime_controls (scope, target_id, enabled)
values ${rows.join(", ")}
on conflict (scope, target_id) do update
set enabled = excluded.enabled, updated_at = now()`,
        values,
      );
    },
  };
}

async function initializeDefaults(
  pool: Pick<pg.Pool, "query">,
  snapshot: RuntimeControllerSnapshot,
): Promise<void> {
  const values: unknown[] = ["global", "global", snapshot.globalEnabled];
  const rows = ["($1, $2, $3)"];

  for (const capability of capabilityNames) {
    const offset = values.length;
    values.push("capability", capability, snapshot.capabilities[capability]);
    rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
  }

  await pool.query(
    `insert into runtime_controls (scope, target_id, enabled)
values ${rows.join(", ")}
on conflict (scope, target_id) do nothing`,
    values,
  );
}

async function upsertControl(
  pool: Pick<pg.Pool, "query">,
  scope: RuntimeControlRow["scope"],
  targetId: string,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    `insert into runtime_controls (scope, target_id, enabled)
values ($1, $2, $3)
on conflict (scope, target_id) do update
set enabled = excluded.enabled, updated_at = now()`,
    [scope, targetId, enabled],
  );
}

function snapshotFromRows(
  defaults: RuntimeControllerSnapshot,
  rows: RuntimeControlRow[],
): RuntimeControllerSnapshot {
  const snapshot: RuntimeControllerSnapshot = {
    globalEnabled: defaults.globalEnabled,
    disabledGroupIds: [],
    capabilities: { ...defaults.capabilities },
  };

  for (const row of rows) {
    if (row.scope === "global" && row.target_id === "global") {
      snapshot.globalEnabled = row.enabled;
      continue;
    }
    if (row.scope === "group" && !row.enabled) {
      snapshot.disabledGroupIds.push(row.target_id);
      continue;
    }
    if (row.scope === "capability" && capabilityNameSet.has(row.target_id)) {
      snapshot.capabilities[row.target_id as RuntimeCapabilityName] = row.enabled;
    }
  }

  snapshot.disabledGroupIds.sort();
  return snapshot;
}
