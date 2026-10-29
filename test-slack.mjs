import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const token = process.env.SLACK_BOT_TOKEN;
const channel = (process.argv[2] || 'dashboard-alerts').replace(/^#/, '');
if (!token) { console.log('Set SLACK_BOT_TOKEN first.'); process.exit(1); }

const api = (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/$/, '');
const slack = (m, body = {}) => fetch(`${api}/${m}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

console.log('1) Checking the token...');
const who = await slack('auth.test');
if (!who.ok) { console.log('   FAILED:', who.error); process.exit(1); }
console.log(`   OK. Workspace: ${who.team}, bot: ${who.user}`);

console.log(`2) Posting a plain message to #${channel}...`);
const m = await slack('chat.postMessage', { channel, text: 'Test from Analytics Insights' });
if (!m.ok) { console.log('   FAILED:', m.error); process.exit(1); }
console.log('   OK. Check Slack.');

console.log('3) Sending a dashboard card through the MCP server...');
const c = new Client({ name: 'live-test', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env, SLACK_BOT_TOKEN: token } }));
const r = await c.callTool({
    name: 'send_notification', arguments: {
        title: 'New dashboard created', channel, url: 'https://example.com', url_label: 'Open dashboards',
        items: [{ title: 'Churn analysis', url: 'https://example.com', fields: { Owner: 'Sagar', Type: 'trend' } }]
    }
});
console.log(r.isError ? '   FAILED:' : '   OK:', r.content[0].text);
await c.close();