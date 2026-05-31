import { serve } from "@hono/node-server";
import app from "./app.js";

const port = parseInt(process.env.PORT || "3111");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Trunk relay running on http://localhost:${info.port}`);
});
