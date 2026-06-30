// Skill = bundle of tools + instructions (spec 13 §2.2)
// Skills live as JSON files in ~/.turbollm/skills/
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
export class SkillStore {
  constructor(private dataDir: string) {}
  get skillsDir(): string {
    return join(this.dataDir, 'skills')
  }
  list(): Skill[] {
    const skills = [...BUILTIN_SKILLS]
    const idSet = new Set(skills.map(s => s.id))
    if (!existsSync(this.skillsDir)) return skills
    const entries = readdirSync(this.skillsDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      if (idSet.has(e.name.slice(0, -5))) continue // skip user files that shadow builtins
      const path = join(this.skillsDir, e.name)
      const skill = this.loadOne(path)
      if (skill) skills.push(skill)
    }
    return skills
  }
  get(id: string): Skill | undefined {
    return this.list().find(s => s.id === id)
  }
  write(skill: Skill): void {
    mkdirSync(this.skillsDir, { recursive: true })
    const path = join(this.skillsDir, `${skill.id}.json`)
    writeFileSync(path, JSON.stringify(skill, null, 2))
  }
  delete(id: string): void {
    const path = join(this.skillsDir, `${id}.json`)
    if (existsSync(path)) rmSync(path)
  }
  private loadOne(path: string): Skill | null {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Skill>
      if (!data.id || typeof data.id !== 'string') return null
      if (!data.name || typeof data.name !== 'string') return null
      if (!data.instructions || typeof data.instructions !== 'string') return null
      if (!Array.isArray(data.tools)) return null
      return { id: data.id, name: data.name, description: data.description || '', instructions: data.instructions, tools: data.tools, builtin: false }
    } catch { return null }
    }
}
export function isBuiltinSkill(id: string): boolean {
  return BUILTIN_SKILLS.some(s => s.id === id)
}
