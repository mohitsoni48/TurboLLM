// Startup composition (spec 27 §4.5).
import { loadChatStoreAdapter, type ChatStoreConfig } from './load-adapter.js'
import { ChatStoreRouter } from './router.js'
import type { ChatStore } from './chat-store.js'

/** Compose the store the daemon runs on. Throws — deliberately — if the configured
 *  adapter cannot be loaded or is unhealthy (spec 27 §4.5). */
export async function buildChatStore(
  cfg: ChatStoreConfig,
  local: ChatStore,
  dataDir: string,
): Promise<ChatStoreRouter> {
  const adapter = await loadChatStoreAdapter(cfg, dataDir)
  return new ChatStoreRouter(local, adapter)
}
