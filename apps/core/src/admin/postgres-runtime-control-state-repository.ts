import {
  decodeDurableRuntimeControlSnapshot,
  normalizeRuntimeControlStateReplacement,
  type DurableRuntimeControlSnapshot,
  type RuntimeControlStateRepository,
} from "./runtime-control-state-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type RuntimeControlStateRow = {
  revision: unknown;
  desired_global_enabled: unknown;
  disabled_group_ids: unknown;
  capabilities: unknown;
  updated_at: unknown;
  updated_by: unknown;
};

const readSql = `
select revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by
from runtime_control_state
where singleton_id = 1
`;

const replaceSql = `
update runtime_control_state
set revision = revision + 1,
    desired_global_enabled = $2,
    disabled_group_ids = $3,
    capabilities = $4::jsonb,
    updated_at = now(),
    updated_by = $5
where singleton_id = 1 and revision = $1
returning revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by
`;

export function createPostgresRuntimeControlStateRepository({
  queryable,
}: {
  queryable: Queryable;
}): RuntimeControlStateRepository {
  return {
    async getSnapshot(): Promise<DurableRuntimeControlSnapshot> {
      const result = await queryable.query<RuntimeControlStateRow>(readSql);
      return decodeOne(result.rows);
    },

    async replaceSnapshot(input) {
      const replacement = normalizeRuntimeControlStateReplacement(input);
      const result = await queryable.query<RuntimeControlStateRow>(replaceSql, [
        replacement.expectedRevision,
        replacement.next.desiredGlobalEnabled,
        replacement.next.disabledGroupIds,
        JSON.stringify(replacement.next.capabilities),
        replacement.updatedBy,
      ]);

      if (result.rows.length === 0) {
        return "conflict";
      }

      return decodeOne(result.rows);
    },
  };
}

function decodeOne(rows: RuntimeControlStateRow[]): DurableRuntimeControlSnapshot {
  if (rows.length !== 1) {
    throw new Error("invalid runtime control snapshot: row");
  }

  return decodeDurableRuntimeControlSnapshot(rows[0]);
}
