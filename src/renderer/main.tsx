import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppStateProvider } from './appstate'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <AppStateProvider>
    <App />
  </AppStateProvider>,
)
