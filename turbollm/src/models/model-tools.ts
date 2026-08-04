// Model-callable list_models tool — same shape as routine-tools.ts's list_routines and
// chat-agent-tools.ts's list_agents. Closes a real gap: create_routine's `modelKey` must be one
// of TurboLLM's own catalog entries (compound ids like "gemma 4 26b a4b qat|Q4_0|14439362752"),
// but until now nothing let a model discover what those actually are. Observed live: a claude_cli
// session asked to create a routine picked `modelKey: "gpt-4"` — a real cloud model name, not
// anything in this machine's library — because it had no data to work from and nothing else to
// guess from. A routine created with a modelKey that doesn't exist can never fire successfully.

/** The narrow slice of Scanner this tool touches. A real Scanner instance satisfies this
 *  structurally (TypeScript structural typing, same idiom as RoutineToolsStore/AgentToolsStore)
 *  — cli.ts just passes `scanner`. Kept narrow so tests can stub it with a plain object. */
export interface ModelToolsStore {
  list(): { models: Array<{ key: string; name: string; quant: string; sizeLabel: string }> }
}

export const LIST_MODELS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_models',
    description:
      'List every model in TurboLLM\'s local library, with the exact modelKey each one needs — a compound ' +
      'id (e.g. "gemma 4 26b a4b qat|Q4_0|14439362752"), never a generic name like "gpt-4" or "claude". ' +
      'Use this BEFORE calling create_routine to get a real modelKey — never guess one.',
    parameters: { type: 'object', properties: {} },
  },
}

export function execListModels(_args: Record<string, unknown>, store: ModelToolsStore): string {
  const { models } = store.list()
  if (models.length === 0) return 'No models in the library yet — add one in TurboLLM\'s Models screen first.'
  return models.map((m) => `- ${m.key} — ${m.name} (${m.quant}, ${m.sizeLabel})`).join('\n')
}
