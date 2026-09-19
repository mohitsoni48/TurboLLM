export interface BranchOptions {
  /** What the dropdown lists. Always contains the selected branch: a <select> whose value matches
   *  no option displays its first option while the state (and the build request) hold another. */
  options: string[]
  /** How many fetched branches match the search. The selected branch is not counted unless it is one. */
  matched: number
}

export function branchOptions(selected: string, fetched: string[], query: string): BranchOptions {
  const needle = query.toLowerCase()
  const matching = needle ? fetched.filter((branch) => branch.toLowerCase().includes(needle)) : fetched
  const options = matching.includes(selected) ? matching : [selected, ...matching]
  return { options, matched: matching.length }
}
