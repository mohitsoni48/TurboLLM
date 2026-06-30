// A skill is a Claude-style SKILL.md file (spec 13 redesign; ADR-135, skill-creator model).
//
// Skills live as folders in ~/.turbollm/skills/<id>/SKILL.md — YAML-ish frontmatter
// (name + description = the "when to use" trigger) followed by a markdown instructions
// body. This is the shared library: any agent can use any skill (each agent's enabled set
// is just a filter over this library). Created skills are authored in the background by
// reading a conversation (see skill-jobs.ts), never hand-typed JSON.
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  tools: string[]
  builtin?: boolean
}
const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read files, list directories, glob patterns within the agent\'s workspace.',
    instructions: 'You can read files and explore directories. Use read_file to read file contents, list_dir to explore, and glob to find files. Always work within your allowed paths.',
    tools: ['read_file', 'list_dir', 'glob'],
    builtin: true,
  },
  {
    id: 'web',
    name: 'Web',
    description: 'Search the web and fetch URLs for research.',
    instructions: 'You can search the web using web_search and fetch URLs with fetch_url. Use these to gather current information and research topics.',
    tools: ['web_search', 'fetch_url'],
    builtin: true,
  },
  {
    id: 'code',
    name: 'Code',
    description: 'Execute code for computation and data processing.',
    instructions: 'You can run code using run_code. Code execution runs unattended — ensure your code is correct before running.',
    tools: ['run_code'],
    builtin: true,
  },
  {
    id: 'task-tracking',
    name: 'Task Tracking',
    description: 'Track progress on a task and declare completion.',
    instructions: 'You can track your progress with update_doc and declare a task complete with complete_task. Update the working doc regularly to maintain a clear record of what\'s done and what\'s left.',
    tools: ['update_doc', 'complete_task'],
    builtin: true,
  },
  {
    id: 'compose',
    name: 'Compose',
    description: 'Delegate work to other agents via call_agent.',
    instructions: 'You can call other agents using call_agent. Use this to delegate specialized sub-tasks to agents with different capabilities.',
    tools: ['call_agent'],
    builtin: true,
  },
]

/** Serialize a skill to Claude SKILL.md format: frontmatter + instructions body. */
export function toSkillMd(skill: Pick<Skill, 'name' | 'description' | 'instructions' | 'tools'>): string {
  const fm = [`name: ${skill.name}`, `description: ${oneLine(skill.description)}`]
  if (skill.tools.length) fm.push(`tools: ${skill.tools.join(', ')}`)
  return `---\n${fm.join('\n')}\n---\n\n${skill.instructions.trim()}\n`
}

/** Parse a SKILL.md back into a skill (id supplied by the caller from the folder name). */
export function fromSkillMd(id: string, text: string): Skill | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const c = line.indexOf(':')
    if (c < 0) continue
    meta[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
  }
  const name = meta.name?.trim()
  const instructions = m[2].trim()
  if (!name || !instructions) return null
  const tools = meta.tools ? meta.tools.split(',').map((t) => t.trim()).filter(Boolean) : []
  return { id, name, description: meta.description ?? '', instructions, tools, builtin: false }
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

export class SkillStore {
  constructor(private dataDir: string) {}
  get skillsDir(): string {
    return join(this.dataDir, 'skills')
  }
  list(): Skill[] {
    const skills = [...BUILTIN_SKILLS]
    const idSet = new Set(skills.map((s) => s.id))
    if (!existsSync(this.skillsDir)) return skills
    for (const e of readdirSync(this.skillsDir, { withFileTypes: true })) {
      let skill: Skill | null = null
      let id = ''
      if (e.isDirectory()) {
        id = e.name
        const md = join(this.skillsDir, e.name, 'SKILL.md')
        if (existsSync(md)) skill = this.loadMd(id, md)
      } else if (e.isFile() && e.name.endsWith('.json')) {
        // Back-compat: read legacy <id>.json skills written before the SKILL.md switch.
        id = e.name.slice(0, -5)
        skill = this.loadJson(join(this.skillsDir, e.name), id)
      }
      if (!skill || !id || idSet.has(id)) continue // skip invalid + shadows of builtins
      idSet.add(id)
      skills.push(skill)
    }
    return skills
  }
  /** Only the user-created (non-builtin) skills, for injection + the library UI. */
  userSkills(): Skill[] {
    return this.list().filter((s) => !s.builtin)
  }
  get(id: string): Skill | undefined {
    return this.list().find((s) => s.id === id)
  }
  has(id: string): boolean {
    return isValidSkillId(id) && existsSync(join(this.skillsDir, id, 'SKILL.md'))
  }
  write(skill: Skill): void {
    if (!isValidSkillId(skill.id)) throw new Error(`Invalid skill id: ${skill.id}`)
    const dir = join(this.skillsDir, skill.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), toSkillMd(skill), 'utf8')
  }
  delete(id: string): void {
    // Defense-in-depth: never let an id escape the skills dir as a path (../, absolute,
    // separators). The route validates too, but write()/delete() are the real boundary.
    if (!isValidSkillId(id)) return
    rmSync(join(this.skillsDir, id), { recursive: true, force: true })
    const legacy = join(this.skillsDir, `${id}.json`)
    if (existsSync(legacy)) rmSync(legacy)
  }
  private loadMd(id: string, path: string): Skill | null {
    try { return fromSkillMd(id, readFileSync(path, 'utf8')) } catch { return null }
  }
  private loadJson(path: string, id: string): Skill | null {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Skill>
      if (!data.name || typeof data.name !== 'string') return null
      if (!data.instructions || typeof data.instructions !== 'string') return null
      return { id, name: data.name, description: data.description || '', instructions: data.instructions, tools: Array.isArray(data.tools) ? data.tools : [], builtin: false }
    } catch { return null }
  }
}
export function isBuiltinSkill(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id)
}

/** A skill id must be safe to use as a folder name: kebab-case only, no separators,
 *  no traversal, bounded length. The single source of truth for both the route
 *  and the storage layer. */
export function isValidSkillId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id)
}

/** Normalize an arbitrary name into a valid kebab-case skill id. */
export function toSkillId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}
