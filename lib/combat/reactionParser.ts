// Yes/no parsing for a pending reaction prompt (spec §2.3).

import type { AwaitingReaction } from "../sim/battle";
import { normalize, similarity } from "./fuzzy";

const YES = /^(y|yes|yeah|yep|sure|do it|take it|use it)\b/;
const NO = /^(n|no|nah|nope|skip|decline|don'?t|save it)\b/;

export type ReactionResult = { kind: "take"; take: boolean } | { kind: "clarify"; question: string };

export function interpretReaction(text: string, awaiting: AwaitingReaction): ReactionResult {
  const n = normalize(text);
  if (YES.test(n)) return { kind: "take", take: true };
  if (NO.test(n)) return { kind: "take", take: false };
  const takeScore = similarity(n, awaiting.takeLabel);
  const declineScore = similarity(n, awaiting.declineLabel);
  if (Math.max(takeScore, declineScore) >= 0.55) return { kind: "take", take: takeScore >= declineScore };
  return {
    kind: "clarify",
    question: `${awaiting.prompt} — ${awaiting.takeLabel}, or ${awaiting.declineLabel}?`,
  };
}
