import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web app is its own program. It calls the backend directly at VITE_API_URL (default
// http://127.0.0.1:8750) -- no proxy -- and the backend allows these two origins. Both
// listen on 127.0.0.1 only, like the backend: nothing here is for another machine.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },   // npm run dev
  preview: { host: '127.0.0.1', port: 8751, strictPort: true },  // npm run serve
})
