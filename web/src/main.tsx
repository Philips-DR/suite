import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts and global styles first: a panel's own stylesheet is imported by the panel, and must load after these.
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'
import './styles/motion.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/charts.css'
import './styles/pages.css'
import { App } from './App'
import { StateProvider } from './state'

const root = document.getElementById('root')
if (!root) throw new Error('no #root element')

createRoot(root).render(
  <StrictMode>
    <StateProvider>
      <App />
    </StateProvider>
  </StrictMode>,
)
