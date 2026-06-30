export type RetrievedDocumentFragment = {
  id: string;
  documentId: string;
  text: string;
};

export type PermissionGuardInput = {
  fragments: RetrievedDocumentFragment[];
  canReadDocument: (documentId: string) => Promise<boolean>;
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
  const permissionCache = new Map<string, boolean>();

  for (const fragment of input.fragments) {
    const allowed = await resolvePermission(fragment.documentId, input.canReadDocument, permissionCache);
    if (allowed) {
      allowedFragments.push(fragment);
    } else {
      deniedDocumentIds.add(fragment.documentId);
    }
  }

  return {
    allowedFragments,
    deniedDocumentIds: [...deniedDocumentIds]
  };
}

async function resolvePermission(
  documentId: string,
  canReadDocument: (documentId: string) => Promise<boolean>,
  permissionCache: Map<string, boolean>
): Promise<boolean> {
  const cached = permissionCache.get(documentId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const allowed = await canReadDocument(documentId);
    permissionCache.set(documentId, allowed);
    return allowed;
  } catch {
    permissionCache.set(documentId, false);
    return false;
  }
}
