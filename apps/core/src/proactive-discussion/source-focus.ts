import type { PdAssessment, PdContext } from "./contracts.js";

export function pdSourceFocusCandidates(context: PdContext) {
  return context.items.flatMap(item => item.text.split(/(?<=[。！？!?；;\n])/u)
    .map(text => text.trim()).filter(text => text.length > 0 && text.length <= 2000)
    .map(sourceQuote => ({ sourceRef: item.ref, sourceQuote })));
}

/** A quotation identifies a discussion topic; it does not make the quoted claim true. */
export function pdSourceFocus(assessment: PdAssessment, context: PdContext) {
  const identity = assessment.issueRef;
  if (identity?.kind !== "new") return null;
  const focus = pdSourceFocusCandidates(context).find(candidate => assessment.evidenceRefs.includes(candidate.sourceRef)
    && candidate.sourceQuote === identity.description);
  if (!focus) throw new Error("new issue source focus must be a sentence from selected evidence");
  return focus;
}

export const sourceFocusAssessmentSystem = "本轮新问题使用原文定位：issueRef.kind=new时，description只能逐字选择schema列出的来源句子，并将该句对应ref包含在evidenceRefs。选能定位当前问题的一句，不在description中改写或追加诊断；观察、理由、建议仍正常分析。原句可能是成员尚未证实或错误的结论，引用它不表示认同。已有问题使用原ID，skip不创建新问题。";
export const sourceFocusReviewSystem = "新问题identityTarget.issueRef.sourceFocus是程序绑定的原文定位，不是初判结论，也不是已证实事实。核对候选是否仍针对该原句与锁定evidence所构成的同一问题；指出原句推理缺口是允许的，不能因候选反驳原句而视为换题。引用或一致性本身不证明候选正确。";
