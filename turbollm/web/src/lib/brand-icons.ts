// Tree-shaken brand icon imports from simple-icons.
// Each exported entry: { path: SVG path for viewBox 0 0 24 24, hex: brand color without # }
// Fallback to colored initials for brands not in this map.

import {
  siGithub, siLinear, siNotion, siFigma, siStripe, siAtlassian,
  siSentry, siSupabase, siNeon, siCloudflare, siZapier, siVercel,
  siHubspot, siMixpanel, siGoogle,
  siPostgresql, siGit, siPuppeteer, siGoogledrive, siBrave,
  siDocker, siRedis, siMongodb, siObsidian, siYoutube, siRss,
  siKubernetes, siMysql, siKagi, siSearxng, siUpstash,
} from 'simple-icons'

export type BrandIcon = { path: string; hex: string }

export const BRAND_ICONS: Record<string, BrandIcon> = {
  // Cloud MCPs
  github:     { path: siGithub.path,     hex: siGithub.hex },
  linear:     { path: siLinear.path,     hex: siLinear.hex },
  notion:     { path: siNotion.path,     hex: siNotion.hex },
  figma:      { path: siFigma.path,      hex: siFigma.hex },
  stripe:     { path: siStripe.path,     hex: siStripe.hex },
  atlassian:  { path: siAtlassian.path,  hex: siAtlassian.hex },
  sentry:     { path: siSentry.path,     hex: siSentry.hex },
  supabase:   { path: siSupabase.path,   hex: siSupabase.hex },
  neon:       { path: siNeon.path,       hex: siNeon.hex },
  cloudflare: { path: siCloudflare.path, hex: siCloudflare.hex },
  zapier:     { path: siZapier.path,     hex: siZapier.hex },
  vercel:     { path: siVercel.path,     hex: siVercel.hex },
  hubspot:    { path: siHubspot.path,    hex: siHubspot.hex },
  mixpanel:   { path: siMixpanel.path,   hex: siMixpanel.hex },
  google:     { path: siGoogle.path,     hex: siGoogle.hex },
  // Local MCPs
  postgresql: { path: siPostgresql.path, hex: siPostgresql.hex },
  git:        { path: siGit.path,        hex: siGit.hex },
  puppeteer:  { path: siPuppeteer.path,  hex: siPuppeteer.hex },
  googledrive:{ path: siGoogledrive.path,hex: siGoogledrive.hex },
  brave:      { path: siBrave.path,      hex: siBrave.hex },
  docker:     { path: siDocker.path,     hex: siDocker.hex },
  redis:      { path: siRedis.path,      hex: siRedis.hex },
  mongodb:    { path: siMongodb.path,    hex: siMongodb.hex },
  obsidian:   { path: siObsidian.path,   hex: siObsidian.hex },
  youtube:    { path: siYoutube.path,    hex: siYoutube.hex },
  rss:        { path: siRss.path,        hex: siRss.hex },
  kubernetes: { path: siKubernetes.path, hex: siKubernetes.hex },
  mysql:      { path: siMysql.path,      hex: siMysql.hex },
  kagi:       { path: siKagi.path,       hex: siKagi.hex },
  searxng:    { path: siSearxng.path,    hex: siSearxng.hex },
  upstash:    { path: siUpstash.path,    hex: siUpstash.hex },
}
