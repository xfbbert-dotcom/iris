import type { AuditLog } from "../audit/audit-log.js";
import { normalizeAuditEventMessage } from "../audit/audit-event-message.js";

export type RetrievedDocumentFragment = {
  id: string;
  documentId: string;
  text: string;
};

export type PermissionGuardInput = {
  fragments: RetrievedDocumentFragment[];
  canReadDocument: (documentId: string) => Promise<boolean>;
  auditLog?: AuditLog;
};

export type PermissionGuardResult = {
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
};

export async function filterFragmentsByLivePermission(
  input: PermissionGuardInput
): Promise<PermissionGuardResult> {
  const allowedFragments: RetrievedDocumentFragment[] = [];
  const deniedDocumentIds = new Set<string>();
  const fragmentIdsByDocumentId = groupFragmentIdsByDocumentId(input.fragments);
  const permissionsByDocumentId = await resolvePermissionsByDocumentId(
    [...fragmentIdsByDocumentId.keys()],
    input.canReadDocument,
  );
  const auditedDocumentIds = new Set<string>();

  for (const fragment of input.fragments) {
    const permission = permissionsByDocumentId.get(fragment.documentId) ?? {
      allowed: false,
      error: new Error("missing permission resolution"),
    };
    if (permission.allowed) {
      allowedFragments.push(fragment);
    } else {
      deniedDocumentIds.add(fragment.documentId);
      await auditDeniedPermission({
        auditLog: input.auditLog,
        auditedDocumentIds,
        documentId: fragment.documentId,
        fragmentIds: fragmentIdsByDocumentId.get(fragment.documentId) ?? [],
        permission: permission
      });
    }
  }

  return {
    allowedFragments,
    deniedDocumentIds: [...deniedDocumentIds]
  };
}

type PermissionResolution =
  | { allowed: true }
  | { allowed: false; error?: unknown };
type DeniedPermissionResolution = Extract<PermissionResolution, { allowed: false }>;

async function resolvePermissionsByDocumentId(
  documentIds: string[],
  canReadDocument: (documentId: string) => Promise<boolean>,
): Promise<Map<string, PermissionResolution>> {
  const entries = await Promise.all(
    documentIds.map(async (documentId) => [
      documentId,
      await resolvePermission(documentId, canReadDocument),
    ] as const),
  );

  return new Map(entries);
}

async function resolvePermission(
  documentId: string,
  canReadDocument: (documentId: string) => Promise<boolean>,
): Promise<PermissionResolution> {
  try {
    const allowed = await canReadDocument(documentId);
    return allowed ? { allowed: true } : { allowed: false };
  } catch (error) {
    return { allowed: false, error };
  }
}

function groupFragmentIdsByDocumentId(
  fragments: RetrievedDocumentFragment[]
): Map<string, string[]> {
  const fragmentIdsByDocumentId = new Map<string, string[]>();
  for (const fragment of fragments) {
    const fragmentIds = fragmentIdsByDocumentId.get(fragment.documentId) ?? [];
    fragmentIds.push(fragment.id);
    fragmentIdsByDocumentId.set(fragment.documentId, fragmentIds);
  }
  return fragmentIdsByDocumentId;
}

async function auditDeniedPermission(input: {
  auditLog?: AuditLog;
  auditedDocumentIds: Set<string>;
  documentId: string;
  fragmentIds: string[];
  permission: DeniedPermissionResolution;
}): Promise<void> {
  if (input.auditLog === undefined || input.auditedDocumentIds.has(input.documentId)) {
    return;
  }

  input.auditedDocumentIds.add(input.documentId);
  try {
    await input.auditLog.record({
      type:
        input.permission.error === undefined
          ? "permission_guard_denied"
          : "permission_guard_error",
      documentId: input.documentId,
      fragmentIds: input.fragmentIds,
      ...(input.permission.error === undefined
        ? {}
        : {
            message: normalizeAuditEventMessage(
              readPermissionErrorMessage(input.permission.error),
            ),
          }),
    });
  } catch {
    // Audit logging is best-effort; permission filtering must stay fail-closed.
  }
}

function readPermissionErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
