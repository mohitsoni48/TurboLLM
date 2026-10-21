import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { App } from './App'
import { createQueryClient } from './query-client'
import { Toaster } from './components/ui/sonner'
import { applyFontSize, applyTheme, useUiStore } from './stores/ui'

// Apply the persisted theme/font-size before first paint to avoid a flash of
// wrong theme or type scale.
applyTheme(useUiStore.getState().theme)
applyFontSize(useUiStore.getState().fontSize)

// Keep the .dark class in sync if the OS theme changes while on "system".
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    if (useUiStore.getState().theme === 'system') {
      applyTheme('system')
    }
  })

const queryClient = createQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)
