import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Allow access from LAN / WSL by binding to all interfaces
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
