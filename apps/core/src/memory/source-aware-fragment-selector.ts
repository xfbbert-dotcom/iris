import type {
  DocumentFragment,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";

const MAX_FRAGMENTS_PER_SOURCE = 3;

export type SourceAwareSelectionInput = {
  queryText: string;
  rankedFragments: readonly RetrievedDocumentFragment[];
  fragmentLimit: number;
  listFragmentsForSnapshot?: (snapshotId: string) => Promise<DocumentFragment[]>;
};

type SourceGroup = {
  bestRank: number;
  titleMatched: boolean;
  fragments: RetrievedDocumentFragment[];
};

export async function selectSourceAwareFragments(
  input: SourceAwareSelectionInput,
): Promise<RetrievedDocumentFragment[]> {
  if (input.fragmentLimit <= 0) {
    return [];
  }
  const groups = groupRankedFragments(input.rankedFragments, input.queryText)
    .sort((left, right) =>
      Number(right.titleMatched) - Number(left.titleMatched) ||
      left.bestRank - right.bestRank);
  const selected: RetrievedDocumentFragment[] = [];
  const leadingGroupCount = Math.max(1, Math.ceil(input.fragmentLimit / 2));
  const leadingGroups = groups.slice(0, leadingGroupCount);
  const overflowGroups = groups.slice(leadingGroupCount);

  for (let round = 0; round < MAX_FRAGMENTS_PER_SOURCE; round += 1) {
    for (const group of leadingGroups) {
      const fragment = group.fragments[round];
      if (fragment !== undefined) {
        selected.push(fragment);
      }
      if (selected.length >= input.fragmentLimit) {
        return selected;
      }
    }
  }

  for (let round = 0; round < MAX_FRAGMENTS_PER_SOURCE; round += 1) {
    for (const group of overflowGroups) {
      const fragment = group.fragments[round];
      if (fragment !== undefined) {
        selected.push(fragment);
      }
      if (selected.length >= input.fragmentLimit) {
        return selected;
      }
    }
  }

  return appendBoundedNeighbors(selected, input);
}

async function appendBoundedNeighbors(
  selected: RetrievedDocumentFragment[],
  input: SourceAwareSelectionInput,
): Promise<RetrievedDocumentFragment[]> {
  if (input.listFragmentsForSnapshot === undefined) {
    return selected;
  }

  const selectedKeys = new Set(selected.map(createFragmentKey));
  const selectedBySource = new Map<string, number>();
  for (const fragment of selected) {
    selectedBySource.set(
      fragment.documentSourceId,
      (selectedBySource.get(fragment.documentSourceId) ?? 0) + 1,
    );
  }
  const snapshots = new Map<string, DocumentFragment[]>();

  for (const seed of [...selected]) {
    if (selected.length >= input.fragmentLimit) {
      break;
    }
    let snapshotFragments = snapshots.get(seed.documentSnapshotId);
    if (snapshotFragments === undefined) {
      snapshotFragments = await input.listFragmentsForSnapshot(seed.documentSnapshotId);
      snapshots.set(seed.documentSnapshotId, snapshotFragments);
    }

    for (const neighbor of snapshotFragments) {
      if (
        neighbor.documentSourceId !== seed.documentSourceId ||
        Math.abs(neighbor.chunkIndex - seed.chunkIndex) !== 1 ||
        neighbor.text.trim().length === 0
      ) {
        continue;
      }
      const key = createFragmentKey(neighbor);
      const sourceCount = selectedBySource.get(neighbor.documentSourceId) ?? 0;
      if (
        selectedKeys.has(key) ||
        sourceCount >= MAX_FRAGMENTS_PER_SOURCE ||
        selected.length >= input.fragmentLimit
      ) {
        continue;
      }
      selected.push({
        ...neighbor,
        sourceTitle: seed.sourceTitle,
        sourceType: seed.sourceType,
      });
      selectedKeys.add(key);
      selectedBySource.set(neighbor.documentSourceId, sourceCount + 1);
    }
  }

  return selected;
}

function createFragmentKey(
  fragment: Pick<DocumentFragment, "documentSourceId" | "id">,
): string {
  return `${fragment.documentSourceId}\u0000${fragment.id}`;
}

function groupRankedFragments(
  rankedFragments: readonly RetrievedDocumentFragment[],
  queryText: string,
): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  rankedFragments.forEach((fragment, rank) => {
    const titleMatched = sourceTitleMatchesQuestion(fragment.sourceTitle, queryText);
    const existing = groups.get(fragment.documentSourceId);
    if (existing === undefined) {
      groups.set(fragment.documentSourceId, {
        bestRank: rank,
        titleMatched,
        fragments: [fragment],
      });
      return;
    }

    existing.titleMatched ||= titleMatched;
    existing.fragments.push(fragment);
  });
  return [...groups.values()];
}

function sourceTitleMatchesQuestion(title: string | undefined, question: string): boolean {
  if (title === undefined) {
    return false;
  }

  const normalizedQuestion = question.normalize("NFKC").toLocaleLowerCase();
  return title.normalize("NFKC").toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => [...token].length >= 3)
    .some((token) => normalizedQuestion.includes(token));
}
