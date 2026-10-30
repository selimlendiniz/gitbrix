// The mark on a branch that has an open pull/merge request: its number,
// colored by what it waits for; a click opens it for review.

import { PullRequest, RefInfo } from "../api";
import { openPullRequest, prLabel, requestForBranch, usePrs, wantsReview } from "../prs";
import { useStore } from "../store";
import { IconPullRequest } from "./Icons";

const NONE: PullRequest[] = [];

/** The open repository's requests. */
export function useRepoRequests(): PullRequest[] {
  const repo = useStore((s) => s.repo?.path);
  return usePrs((s) => (repo ? (s.byRepo[repo]?.items ?? NONE) : NONE));
}

/** The open request of a branch in the open repository, if any. */
export function useBranchRequest(local: RefInfo | null, remotes: RefInfo[]): PullRequest | undefined {
  return requestForBranch(useRepoRequests(), local, remotes);
}

export function requestState(pr: PullRequest): { kind: string; text: string } {
  if (pr.draft) return { kind: "draft", text: "draft" };
  if (pr.ci === "failed") return { kind: "failed", text: "checks failed" };
  if (wantsReview(pr)) return { kind: "review", text: pr.reviewRequested ? "your review is requested" : "you can approve it" };
  if (pr.approved) return { kind: "approved", text: "approved" };
  return { kind: "open", text: "waiting for review" };
}

export function PrMark({ pr }: { pr: PullRequest }) {
  const state = requestState(pr);
  return (
    <button
      type="button"
      className={`pr-mark ${state.kind}`}
      title={`${prLabel(pr)} ${pr.title}\n${pr.sourceBranch} → ${pr.targetBranch} · ${state.text}${pr.ci ? ` · CI ${pr.ci}` : ""}\nClick to review`}
      aria-label={`Pull request ${prLabel(pr)}`}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openPullRequest(pr);
      }}
    >
      <IconPullRequest size={11} />
      {prLabel(pr)}
    </button>
  );
}
