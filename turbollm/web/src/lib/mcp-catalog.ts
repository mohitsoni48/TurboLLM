// Curated MCP server catalog (ADR-124). Two categories:
// - Cloud: hosted/SaaS MCPs connected via SSE (Streamable HTTP) with API key auth
// - Local: open-source stdio MCPs spawned via npx or uvx
//
// Auth kinds for Cloud:
//   'key'       — API key / Bearer token only
//   'oauth'     — OAuth only (no token path; note shown in UI)
//   'oauth-key' — either OAuth OR API key
//
// iconSlug: key into BRAND_ICONS from brand-icons.ts; omit to fall back to colored initials

export type AuthKind = 'key' | 'oauth' | 'oauth-key'

export type CloudEntry = {
  id: string
  name: string
  cat: string
  desc: string
  auth: AuthKind
  color: string
  url: string
  iconSlug?: string
  keyNote?: string
}

export type EnvVar = {
  key: string
  desc: string
  required: boolean
}

export type LocalEntry = {
  id: string
  name: string
  cat: string
  desc: string
  cmd: string
  envs: EnvVar[]
  uvx?: boolean
  iconSlug?: string
  argNote?: string
}

/** The three built-in web-search providers (spec 06 §5 / ADR-082). These are NOT MCP
 *  servers — there is exactly one active provider at a time (`DaemonSettings.search`), so
 *  they're kept out of LOCAL_MCPS entirely and rendered as their own "Built-in web search"
 *  picker in the Customize screen, each with its own config, not a 3-way form shared by all. */
export type BuiltinSearchEntry = {
  id: 'tavily' | 'kagi' | 'searxng'
  name: string
  desc: string
  iconSlug?: string
}

export const BUILTIN_SEARCH: BuiltinSearchEntry[] = [
  { id: 'tavily', name: 'Tavily', desc: 'AI-search API tuned for LLMs.' },
  { id: 'kagi', name: 'Kagi', desc: 'Premium search with no ads or tracking.', iconSlug: 'kagi' },
  { id: 'searxng', name: 'SearXNG', desc: 'Self-hosted meta-search, fully local — no API key required.', iconSlug: 'searxng' },
]

// Only entries where a static API key / Bearer token is confirmed to work against the
// official hosted MCP endpoint. Verified 2026-06-29 against official docs for each service.
// OAuth-only (Notion, Figma, Sentry, Vercel, HubSpot, Amplitude, Slack) are excluded.
// Motion excluded: no confirmed official hosted endpoint exists.
// Stitch (Google) excluded: its MCP needs an X-Goog-Api-Key header (we only inject
// Authorization: Bearer) and rejects API keys anyway — OAuth2-only in practice.
export const CLOUD_MCPS: CloudEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    cat: 'Dev Tools',
    desc: 'Issues, PRs, code search, and repo management.',
    auth: 'key',
    color: '#24292e',
    iconSlug: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    keyNote: 'Use a GitHub Personal Access Token (PAT) from github.com → Settings → Developer settings → PATs.',
  },
  {
    id: 'linear',
    name: 'Linear',
    cat: 'Project Mgmt',
    desc: 'Issues, projects, sprints, and cycles.',
    auth: 'key',
    color: '#5e6ad2',
    iconSlug: 'linear',
    url: 'https://mcp.linear.app/mcp',
    keyNote: 'Generate an API key at linear.app → Settings → API.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    cat: 'Payments',
    desc: 'Charges, customers, and subscriptions.',
    auth: 'key',
    color: '#4f46bf',
    iconSlug: 'stripe',
    url: 'https://mcp.stripe.com',
    keyNote: 'Use a restricted key (rk_live_… or rk_test_…) from dashboard.stripe.com → Developers → API keys. Prefer restricted keys over secret keys.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    cat: 'Project Mgmt',
    desc: 'Jira, Confluence, Bitbucket, and Compass.',
    auth: 'key',
    color: '#0040a0',
    iconSlug: 'atlassian',
    url: 'https://mcp.atlassian.com/v1/mcp',
    keyNote: 'Requires a service-account API key (Bearer). Personal API tokens use Basic auth and won\'t work here. Generate a service-account key from admin.atlassian.com → API keys.',
  },
  {
    id: 'neon',
    name: 'Neon',
    cat: 'Database',
    desc: 'Serverless Postgres — branches and queries.',
    auth: 'key',
    color: '#007a44',
    iconSlug: 'neon',
    url: 'https://mcp.neon.tech/mcp',
    keyNote: 'Generate an API key at console.neon.tech → Account → API Keys.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    cat: 'Database',
    desc: 'Tables, auth, storage, and edge functions.',
    auth: 'key',
    color: '#136b46',
    iconSlug: 'supabase',
    url: 'https://mcp.supabase.com/mcp',
    keyNote: 'Generate a personal access token at supabase.com → Account → Access Tokens.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    cat: 'Cloud',
    desc: 'Workers, KV, D1, R2, and DNS management.',
    auth: 'key',
    color: '#f48120',
    iconSlug: 'cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    keyNote: 'Create an API token at dash.cloudflare.com → Profile → API Tokens. Note: tokens with IP address filtering enabled do not work.',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    cat: 'Automation',
    desc: 'Trigger and query 7,000+ app automations.',
    auth: 'key',
    color: '#ff4a00',
    iconSlug: 'zapier',
    url: 'https://mcp.zapier.com/api/v1/connect',
    keyNote: 'Get a connection token from zapier.com/mcp — Zapier issues a per-server token that you paste here.',
  },
  {
    id: 'apify',
    name: 'Apify',
    cat: 'Automation',
    desc: 'Run web scrapers, browse the web with RAG, and query Apify datasets.',
    auth: 'key',
    color: '#00c45a',
    url: 'https://mcp.apify.com',
    keyNote: 'Get an API token at console.apify.com → Settings → API & Integrations.',
  },
  {
    id: 'mixpanel',
    name: 'Mixpanel',
    cat: 'Analytics',
    desc: 'Query events, funnels, retention, and user profiles.',
    auth: 'key',
    color: '#7856ff',
    iconSlug: 'mixpanel',
    url: 'https://mcp.mixpanel.com/mcp',
    keyNote: 'Create a service account at mixpanel.com → Settings → Service Accounts, then run: echo -n "username:secret" | base64 — and paste "Basic <that-base64>" here (include the word Basic).',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    cat: 'Automation',
    desc: 'Scrape, crawl, and search the live web into clean, LLM-ready pages.',
    auth: 'key',
    color: '#fa5d19',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    keyNote: 'Get an API key at firecrawl.dev → API Keys. A keyless tier works for basic scrape/search, but crawl/extract/agent tools and higher limits need a key.',
  },
]

export const LOCAL_MCPS: LocalEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    cat: 'File System',
    desc: 'Read/write local files with a configurable path allow-list.',
    cmd: 'npx -y @modelcontextprotocol/server-filesystem',
    envs: [],
    argNote: 'Provide the directory path(s) to allow access to as command arguments.',
  },
  {
    id: 'memory',
    name: 'Memory',
    cat: 'AI',
    desc: 'Persistent knowledge graph across sessions.',
    cmd: 'npx -y @modelcontextprotocol/server-memory',
    envs: [],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    cat: 'Search',
    desc: 'Web and news search via Brave Search API.',
    cmd: 'npx -y @modelcontextprotocol/server-brave-search',
    iconSlug: 'brave',
    envs: [{ key: 'BRAVE_API_KEY', desc: 'From search.brave.com → API', required: true }],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    cat: 'Database',
    desc: 'Natural-language queries against PostgreSQL.',
    cmd: 'npx -y @modelcontextprotocol/server-postgres',
    iconSlug: 'postgresql',
    envs: [],
    argNote: 'Provide the connection string as an argument: postgresql://user:pass@host/db',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    cat: 'Database',
    desc: 'Query and inspect local SQLite databases.',
    cmd: 'npx -y @modelcontextprotocol/server-sqlite',
    envs: [],
    argNote: 'Provide the path to your .sqlite file as an argument.',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    cat: 'Browser',
    desc: 'Headless Chromium for screenshots and form automation.',
    cmd: 'npx -y @modelcontextprotocol/server-puppeteer',
    iconSlug: 'puppeteer',
    envs: [],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    cat: 'Browser',
    desc: 'DOM-aware browser automation from Microsoft.',
    cmd: 'npx @playwright/mcp@latest',
    envs: [],
  },
  {
    id: 'sequential',
    name: 'Sequential Thinking',
    cat: 'AI',
    desc: 'Dynamic step-by-step reasoning scaffold.',
    cmd: 'npx -y @modelcontextprotocol/server-sequentialthinking',
    envs: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    cat: 'Web',
    desc: 'Fetch any URL and convert to LLM-friendly markdown.',
    cmd: 'uvx mcp-server-fetch',
    envs: [],
    uvx: true,
  },
  {
    id: 'git',
    name: 'Git',
    cat: 'Dev Tools',
    desc: 'Commit, diff, log, branch, and blame operations.',
    cmd: 'uvx mcp-server-git',
    iconSlug: 'git',
    envs: [],
    uvx: true,
    argNote: 'Provide --repository /path/to/your/repo as an argument.',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    cat: 'File System',
    desc: 'Search and read files from Google Drive.',
    cmd: 'npx -y @modelcontextprotocol/server-google-drive',
    iconSlug: 'googledrive',
    envs: [{ key: 'GDRIVE_CREDENTIALS_JSON', desc: 'Path to your credentials.json file', required: true }],
  },
  {
    id: 'redis',
    name: 'Redis',
    cat: 'Database',
    desc: 'Read and write Redis keys, hashes, lists, and streams.',
    cmd: 'uvx mcp-server-redis',
    iconSlug: 'redis',
    uvx: true,
    envs: [
      { key: 'REDIS_HOST', desc: 'Redis host (default: localhost)', required: false },
      { key: 'REDIS_PORT', desc: 'Redis port (default: 6379)', required: false },
      { key: 'REDIS_PASSWORD', desc: 'Redis password if auth is enabled', required: false },
    ],
  },
  {
    id: 'mysql',
    name: 'MySQL',
    cat: 'Database',
    desc: 'Query and manage MySQL databases with natural language.',
    cmd: 'uvx mcp-server-mysql',
    iconSlug: 'mysql',
    uvx: true,
    envs: [
      { key: 'MYSQL_HOST', desc: 'MySQL host (default: localhost)', required: false },
      { key: 'MYSQL_USER', desc: 'Database user', required: true },
      { key: 'MYSQL_PASSWORD', desc: 'Database password', required: true },
      { key: 'MYSQL_DATABASE', desc: 'Target database name', required: true },
    ],
  },
  {
    id: 'docker',
    name: 'Docker',
    cat: 'Dev Tools',
    desc: 'Manage containers, images, volumes, and networks.',
    cmd: 'uvx docker-mcp',
    iconSlug: 'docker',
    uvx: true,
    envs: [],
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    cat: 'Dev Tools',
    desc: 'Inspect pods, deployments, services, and cluster state.',
    cmd: 'npx -y mcp-server-kubernetes',
    iconSlug: 'kubernetes',
    envs: [],
  },
  {
    id: 'excel',
    name: 'Excel',
    cat: 'Productivity',
    desc: 'Read and write Excel (.xlsx) spreadsheet files.',
    cmd: 'npx -y @negokaz/excel-mcp-server',
    envs: [],
    argNote: 'Set EXCEL_FILE_PATH env var or pass the path as an argument.',
  },
  {
    id: 'pdf',
    name: 'PDF Reader',
    cat: 'File System',
    desc: 'Extract text and metadata from local PDF files.',
    cmd: 'npx -y @sylphlab/pdf-reader-mcp',
    envs: [],
  },
  {
    id: 'youtube',
    name: 'YouTube Transcript',
    cat: 'Web',
    desc: 'Fetch full transcripts from any YouTube video.',
    cmd: 'uvx mcp-youtube-transcript',
    iconSlug: 'youtube',
    uvx: true,
    envs: [],
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    cat: 'Productivity',
    desc: 'Search and read notes from a local Obsidian vault.',
    cmd: 'npx -y obsidian-mcp-server@latest',
    iconSlug: 'obsidian',
    envs: [
      { key: 'OBSIDIAN_API_KEY', desc: 'From the Local REST API community plugin settings', required: true },
      { key: 'OBSIDIAN_HOST', desc: 'Obsidian REST API host (default: localhost)', required: false },
    ],
  },
  {
    id: 'comfyui',
    name: 'ComfyUI MCP',
    cat: 'AI',
    desc: 'Control a local ComfyUI to generate images/video, run workflows, and download models.',
    cmd: 'npx -y comfyui-mcp',
    envs: [
      { key: 'COMFYUI_URL', desc: 'ComfyUI server URL (default: http://127.0.0.1:8188)', required: false },
      { key: 'CIVITAI_API_TOKEN', desc: 'For downloading models from CivitAI', required: false },
      { key: 'HUGGINGFACE_TOKEN', desc: 'For downloading models from Hugging Face', required: false },
    ],
  },
  {
    id: 'context7',
    name: 'Context7',
    cat: 'AI',
    desc: 'Up-to-date, version-specific docs and code examples for any library.',
    cmd: 'npx -y @upstash/context7-mcp',
    iconSlug: 'upstash',
    envs: [
      { key: 'CONTEXT7_API_KEY', desc: 'Optional — from context7.com/dashboard for higher rate limits', required: false },
    ],
  },
  {
    id: 'mcp-web-engine',
    name: 'MCP Web Engine',
    cat: 'Search',
    desc: 'Privacy-first, self-hostable & SSRF-hardened web search engine and scraper for AI agents.',
    cmd: 'uvx mcp-web-engine',
    uvx: true,
    argNote: 'Requires a running SearXNG instance.',
    envs: [
      { key: 'SEARXNG_URL', desc: 'SearXNG meta-search endpoint (default: http://127.0.0.1:8082/search)', required: true },
    ],
  },
]

export const CLOUD_CATS: string[] = ['All', ...new Set(CLOUD_MCPS.map((m) => m.cat))]
export const LOCAL_CATS: string[] = ['All', ...new Set(LOCAL_MCPS.map((m) => m.cat))]
