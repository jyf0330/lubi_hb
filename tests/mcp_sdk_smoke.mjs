// SDK_ROOT points at an existing @modelcontextprotocol/sdk installation.
import { pathToFileURL } from 'node:url';
const root = process.env.SDK_ROOT;
if (!root || !process.env.MCP_TEST_URL) throw new Error('SDK_ROOT and MCP_TEST_URL required');
const { Client } = await import(pathToFileURL(`${root}/dist/esm/client/index.js`));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(`${root}/dist/esm/client/streamableHttp.js`));
const client = new Client({ name: 'board-isolated-test', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_TEST_URL), {
    requestInit: { headers: { Authorization: 'Bearer test-only-ZHC' } },
  }));
  const { tools } = await client.listTools();
  if (!tools.some(t => t.name === 'work_report_heartbeat')) throw new Error('Heartbeat tool missing');
  const result = await client.callTool({ name: 'work_get_active', arguments: {} });
  if (result.isError || result.structuredContent?.ok !== true) throw new Error('Read failed');
  await client.ping();
  console.log(`MCP_SDK_OK tools=${tools.length}`);
} finally {
  await client.close();
}
