#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dashboardBlocks, isEmail, notificationBlocks, slack } from './slack.js';

// One process = one Slack workspace. The platform starts it with that workspace's bot token.
const TOKEN = process.env.SLACK_BOT_TOKEN || '';

const server = new McpServer({ name: 'slack-analytics-mcp-server', version: '0.2.0' });

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });
const need = () => { if (!TOKEN) throw new Error('SLACK_BOT_TOKEN is not set'); return TOKEN; };

async function dmByEmail(email: string, msg: { text: string; blocks?: unknown[] }) {
  const t = need();
  const { user } = await slack<{ user: { id: string; real_name?: string } }>(t, 'users.lookupByEmail', { email });
  const { channel } = await slack<{ channel: { id: string } }>(t, 'conversations.open', { users: user.id });
  const sent = await slack<{ ts: string }>(t, 'chat.postMessage', { channel: channel.id, ...msg, unfurl_links: false });
  return { email, userId: user.id, channel: channel.id, ts: sent.ts };
}

server.registerTool('get_workspace', {
  description: 'Check the connection. Returns the Slack workspace name, id and the bot user. Use it to validate a token when a user adds a workspace.',
  inputSchema: {},
}, async () => {
  try {
    const r = await slack<any>(need(), 'auth.test');
    return text({ ok: true, workspace: r.team, workspaceId: r.team_id, url: r.url, botUserId: r.user_id, botName: r.user });
  } catch (e) { return fail(e); }
});

server.registerTool('lookup_user_by_email', {
  description: 'Find a person in the workspace by their email address. Needs the users:read.email scope.',
  inputSchema: { email: z.string().describe('Work email of the person') },
}, async ({ email }) => {
  try {
    if (!isEmail(email)) throw new Error(`"${email}" is not a valid email`);
    const { user } = await slack<any>(need(), 'users.lookupByEmail', { email });
    return text({ id: user.id, name: user.real_name || user.name, email, deleted: Boolean(user.deleted), isBot: Boolean(user.is_bot) });
  } catch (e) { return fail(e); }
});

server.registerTool('list_channels', {
  description: 'List public channels the bot can post to, so the user can pick one in the UI.',
  inputSchema: { limit: z.number().int().min(1).max(200).optional(), query: z.string().optional().describe('Filter by name') },
}, async ({ limit, query }) => {
  try {
    const r = await slack<any>(need(), 'conversations.list', { types: 'public_channel', exclude_archived: true, limit: limit ?? 200 });
    const q = query?.toLowerCase();
    const channels = r.channels.filter((c: any) => !q || c.name.includes(q)).map((c: any) => ({ id: c.id, name: c.name, isMember: Boolean(c.is_member) }));
    return text({ channels });
  } catch (e) { return fail(e); }
});

server.registerTool('send_dm', {
  description: 'Send a direct message to one person, found by email.',
  inputSchema: { email: z.string(), text: z.string().describe('Message text (Slack mrkdwn)') },
}, async ({ email, text: body }) => {
  try {
    if (!isEmail(email)) throw new Error(`"${email}" is not a valid email`);
    return text(await dmByEmail(email, { text: body }));
  } catch (e) { return fail(e); }
});

server.registerTool('post_to_channel', {
  description: 'Post a message to a channel, by name (e.g. "growth") or id. The bot must be in the channel unless it has chat:write.public.',
  inputSchema: { channel: z.string(), text: z.string() },
}, async ({ channel, text: body }) => {
  try {
    const r = await slack<any>(need(), 'chat.postMessage', { channel: channel.replace(/^#/, ''), text: body, unfurl_links: false });
    return text({ channel: r.channel, ts: r.ts });
  } catch (e) { return fail(e); }
});

server.registerTool('send_dashboard_link', {
  description: 'Send a dashboard link to Slack. Give emails to DM each person and/or a channel to post in. One failure does not stop the others; the result lists every recipient with sent true/false.',
  inputSchema: {
    url: z.string().url().describe('Link to the dashboard'),
    title: z.string().optional().describe('Dashboard or workflow name'),
    message: z.string().optional().describe('Short summary shown above the button'),
    emails: z.array(z.string()).optional().describe('People to DM, by work email'),
    channel: z.string().optional().describe('Channel name or id to post in'),
  },
}, async ({ url, title, message, emails = [], channel }) => {
  try {
    const t = need();
    if (!emails.length && !channel) throw new Error('Give at least one email or a channel');
    const fallback = `${title || 'Your dashboard is ready'}: ${url}`;
    const payload = { text: fallback, blocks: dashboardBlocks({ title, url, message }) };
    const results: { to: string; sent: boolean; error?: string }[] = [];
    for (const email of [...new Set(emails.map((e) => e.trim()).filter(Boolean))]) {
      try {
        if (!isEmail(email)) throw new Error('not a valid email');
        await dmByEmail(email, payload);
        results.push({ to: email, sent: true });
      } catch (e) { results.push({ to: email, sent: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (channel) {
      try {
        await slack(t, 'chat.postMessage', { channel: channel.replace(/^#/, ''), ...payload, unfurl_links: false });
        results.push({ to: `#${channel.replace(/^#/, '')}`, sent: true });
      } catch (e) { results.push({ to: `#${channel.replace(/^#/, '')}`, sent: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    const failed = results.filter((r) => !r.sent).length;
    return { ...text({ sent: results.length - failed, failed, results }), ...(failed === results.length ? { isError: true } : {}) };
  } catch (e) { return fail(e); }
});

server.registerTool('send_notification', {
  description: 'Send a notification about anything (a new record, an alert, a summary) to a channel and/or people by email. Pass the data as fields or items; several items are sent as ONE message. The caller decides WHAT is new; this tool only delivers it.',
  inputSchema: {
    title: z.string().describe('Headline, e.g. "New dashboard created"'),
    text: z.string().optional().describe('Short sentence under the headline'),
    items: z.array(z.object({
      title: z.string().optional(),
      url: z.string().url().optional(),
      fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    })).optional().describe('One entry per new record. Shown as name + key/value lines'),
    url: z.string().url().optional().describe('Button link'),
    url_label: z.string().optional(),
    channel: z.string().optional().describe('Channel name or id'),
    emails: z.array(z.string()).optional().describe('People to DM, by work email'),
  },
}, async ({ title, text: body, items, url, url_label, channel, emails = [] }) => {
  try {
    const t = need();
    if (!emails.length && !channel) throw new Error('Give at least one email or a channel');
    const count = items?.length ? ` (${items.length})` : '';
    const payload = { text: `${title}${count}${body ? `: ${body}` : ''}`, blocks: notificationBlocks({ title: `${title}${count}`, text: body, items, url, urlLabel: url_label }) };
    const results: { to: string; sent: boolean; error?: string }[] = [];
    for (const email of [...new Set(emails.map((e) => e.trim()).filter(Boolean))]) {
      try { if (!isEmail(email)) throw new Error('not a valid email'); await dmByEmail(email, payload); results.push({ to: email, sent: true }); }
      catch (e) { results.push({ to: email, sent: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (channel) {
      const name = channel.replace(/^#/, '');
      try { await slack(t, 'chat.postMessage', { channel: name, ...payload, unfurl_links: false }); results.push({ to: `#${name}`, sent: true }); }
      catch (e) { results.push({ to: `#${name}`, sent: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    const failed = results.filter((r) => !r.sent).length;
    return { ...text({ sent: results.length - failed, failed, results }), ...(failed === results.length ? { isError: true } : {}) };
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
