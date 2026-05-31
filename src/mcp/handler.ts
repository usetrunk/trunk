import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTrunkMcpServer } from "./server.js";

export async function handleMcpRequest(req: Request): Promise<Response> {
  // Stateless mode: each request gets its own server+transport
  // This works well with serverless (Vercel) where there's no persistent connection
  const server = createTrunkMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
