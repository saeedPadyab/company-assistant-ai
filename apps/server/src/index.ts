import { serve } from "@hono/node-server"
import app from "./app.js"

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001) }, (info) => {
  console.log(`http://localhost:${info.port}`)
})
