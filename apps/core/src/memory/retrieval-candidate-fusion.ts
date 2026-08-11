import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";

const RRF_OFFSET = 60;
const PRIMARY_WEIGHT = 2;
const SUPPLEMENTAL_WEIGHT = 1;

type RankedCandidate = {
  fragment: RetrievedDocumentFragment;
  score: number;
  firstSeen: number;
};

export function fuseRetrievedDocumentFragments(input: {
  primary: readonly RetrievedDocumentFragment[];
  supplemental?: readonly RetrievedDocumentFragment[];
}): RetrievedDocumentFragment[] {
  const candidates = new Map<string, RankedCandidate>();
  let firstSeen = 0;

  addRanks(input.primary, PRIMARY_WEIGHT);
  addRanks(input.supplemental ?? [], SUPPLEMENTAL_WEIGHT);

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .map(({ fragment }) => fragment);

  function addRanks(
    fragments: readonly RetrievedDocumentFragment[],
    weight: number,
  ): void {
    fragments.forEach((fragment, index) => {
      const key = `${fragment.documentSourceId}\u0000${fragment.id}`;
      const score = weight / (RRF_OFFSET + index + 1);
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, { fragment, score, firstSeen });
        firstSeen += 1;
      } else {
        existing.score += score;
      }
    });
  }
}
