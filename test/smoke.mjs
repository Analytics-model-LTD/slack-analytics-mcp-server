// Starts a fake Slack API, runs the real MCP server over stdio and calls every tool.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const posted = [];
const users = { 'priya@acme.com': 'U1' };
const api = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const p = b ? JSON.parse(b) : {}; const m = req.url.slice(1);
    const out = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer xoxb-test') return out({ ok: false, error: 'invalid_auth' });
    if (m === 'auth.test') return out({ ok: true, team: 'Acme', team_id: 'T1', url: 'https://acme.slack.com/', user_id: 'B1', user: 'insights' });
    if (m === 'users.lookupByEmail') return users[p.email] ? out({ ok: true, user: { id: users[p.email], real_name: 'Priya' } }) : out({ ok: false, error: 'users_not_found' });
    if (m === 'conversations.open') return out({ ok: true, channel: { id: 'D' + p.users } });
    if (m === 'conversations.list') return out({ ok: true, channels: [{ id: 'C1', name: 'growth', is_member: true }, { id: 'C2', name: 'ops' }] });
    if (m === 'chat.postMessage') { posted.push(p); return p.channel === 'nope' ? out({ ok: false, error: 'channel_not_found' }) : out({ ok: true, channel: p.channel, ts: '1.1' }); }
    out({ ok: false, error: 'unknown_method' });
  });
});
await new Promise((r) => api.listen(0, r));
const url = `http://127.0.0.1:${api.address().port}`;

const client = new Client({ name: 't', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_API_URL: url } }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: !!r.isError, data: r.content[0].text }; };
const checks = [];
const ok = (n, c) => { checks.push([n, !!c]); };

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
let r = await call('get_workspace'); ok('workspace', JSON.parse(r.data).workspace === 'Acme');
r = await call('lookup_user_by_email', { email: 'priya@acme.com' }); ok('lookup', JSON.parse(r.data).id === 'U1');
r = await call('lookup_user_by_email', { email: 'ghost@acme.com' }); ok('lookup missing is error', r.err && /users_not_found/.test(r.data));
r = await call('list_channels', { query: 'gro' }); ok('channels filter', JSON.parse(r.data).channels.length === 1);
r = await call('send_dm', { email: 'priya@acme.com', text: 'hi' }); ok('dm', !r.err && posted.at(-1).channel === 'DU1');
r = await call('send_dashboard_link', { url: 'https://app.x/d/1', title: 'Churn', emails: ['priya@acme.com', 'ghost@acme.com', 'bad'], channel: '#growth' });
const d = JSON.parse(r.data); ok('link partial', !r.err && d.sent === 2 && d.failed === 2);
ok('blocks have button', posted.at(-1).blocks.some((b) => b.type === 'actions') && posted.at(-1).channel === 'growth');
r = await call('send_dashboard_link', { url: 'https://app.x/d/1', channel: 'nope' }); ok('all failed is error', r.err);
r = await call('send_dashboard_link', { url: 'https://app.x/d/1' }); ok('needs recipient', r.err);
r = await call('send_notification', { title: 'New dashboard created', channel: 'growth', url: 'https://app.x/d', url_label: 'Open dashboards',
  items: [{ title: 'Churn <v2>', url: 'https://app.x/d/9', fields: { Owner: 'Priya', Type: 'trend' } }, { title: 'Revenue', fields: { Owner: 'Sam' } }] });
ok('notify sent', !r.err && JSON.parse(r.data).sent === 1);
const nb = posted.at(-1).blocks; ok('notify one message, 2 items', nb.filter((b) => b.type === 'section').length === 2 && /Churn &lt;v2&gt;/.test(nb[1].text.text) && posted.at(-1).text.includes('(2)'));
r = await call('send_notification', { title: 'x' }); ok('notify needs recipient', r.err);
for (const [n, c] of checks) console.log(c ? 'PASS' : 'FAIL', n);
await client.close(); api.close();
process.exit(checks.every(([, c]) => c) ? 0 : 1);
