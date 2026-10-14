import type { ModelChoice, ModelGroup } from './remote-models'

export interface FilteredPicker {
  /** Groups to render, in input order. */
  groups: ModelGroup[]
  /** Visible choices flattened in render order: the keyboard index space. */
  choices: ModelChoice[]
}

/** Lower-cased, whitespace-split tokens of a query; [] for blank. */
export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Source repo (`owner/repo`) of each local model, by choice id. Remote models have none. */
export type RepoByKey = ReadonlyMap<string, string>

/** True when every token is a substring of the choice's name, quant, machine or source repo.
 *  Never the id: a local id is `name|quant|sizeBytes`, so searching it would match size digits. */
export function choiceMatches(choice: ModelChoice, tokens: string[], sourceRepo?: string | null): boolean {
  const searchable = [choice.name, choice.quant ?? '', choice.machine ?? '', sourceRepo ?? ''].join(' ').toLowerCase()
  return tokens.every((token) => searchable.includes(token))
}

export function filterModelGroups(groups: ModelGroup[], query: string, repoByKey?: RepoByKey): FilteredPicker {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return { groups, choices: groups.flatMap((g) => g.choices) }

  const shown: ModelGroup[] = []
  for (const group of groups) {
    const choices = group.choices.filter((c) => choiceMatches(c, tokens, c.remote ? null : repoByKey?.get(c.id)))
    if (choices.length > 0 || isMachineNamedBy(group, tokens)) shown.push({ ...group, choices })
  }
  return { groups: shown, choices: shown.flatMap((g) => g.choices) }
}

/** Next highlighted index for ArrowUp/ArrowDown over `count` targets; clamps, no wrap. */
export function moveActiveIndex(key: string, index: number, count: number): number {
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return index
  if (count === 0) return -1
  if (key === 'ArrowDown') return Math.min(index + 1, count - 1)
  return index < 0 ? count - 1 : Math.max(index - 1, 0)
}

/** Where the highlight is now, given the key of the target the user last highlighted.
 *  Follows the row (even a disabled one: an explicit choice is respected); otherwise the first
 *  PICKABLE match while searching, else none. Never lands on the Eject target (the last of
 *  `targetKeys` beyond `choiceCount`) unless it IS `activeKey`. */
export function resolveActiveIndex(
  activeKey: string | null,
  targetKeys: string[],
  choiceCount: number,
  hasQuery: boolean,
  disabledKeys: ReadonlySet<string>,
): number {
  const followed = activeKey === null ? -1 : targetKeys.indexOf(activeKey)
  if (followed >= 0) return followed
  if (!hasQuery) return -1
  return targetKeys.slice(0, choiceCount).findIndex((key) => !disabledKeys.has(key))
}

function isMachineNamedBy(group: ModelGroup, tokens: string[]): boolean {
  const label = group.label.toLowerCase()
  return group.kind === 'machine' && tokens.every((token) => label.includes(token))
}
