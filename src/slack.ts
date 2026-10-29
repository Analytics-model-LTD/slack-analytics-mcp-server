// Thin Slack Web API client. One bot token = one workspace.
const BASE = (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/$/, '');

export class SlackError extends Error {
  constructor(public code: string, public method: string) {
    super(`Slack ${method} failed: ${code}${HINTS[code] ? ` (${HINTS[code]})` : ''}`);
  }
}

const HINTS: Record<string, string> = {
  invalid_auth: 'the bot token is wrong or revoked',
  not_authed: 'no bot token was provided',
  users_not_found: 'no one in this workspace has that email',
  missing_scope: 'add the missing scope to the Slack app and reinstall it',
  channel_not_found: 'check the channel name or id',
  not_in_channel: 'invite the bot to the channel, or add the chat:write.public scope',
  is_archived: 'the channel is archived',
};

export async function slack<T = any>(token: string, method: string, params: Record<string, unknown> = {}, tries = 3): Promise<T> {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  });
  if (res.status === 429 && tries > 1) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 30);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return slack(token, method, params, tries - 1);
  }
  if (!res.ok) throw new SlackError(`http_${res.status}`, method);
  const data = (await res.json()) as any;
  if (!data.ok) throw new SlackError(data.error || 'unknown_error', method);
  return data as T;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

export function dashboardBlocks(opts: { title?: string; url: string; message?: string }) {
  const title = opts.title || 'Your dashboard is ready';
  return [
    { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
    ...(opts.message ? [{ type: 'section', text: { type: 'mrkdwn', text: opts.message.slice(0, 2900) } }] : []),
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, url: opts.url, style: 'primary' }] },
  ];
}

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type NotifyItem = { title?: string; url?: string; fields?: Record<string, unknown> };

// Generic notification card: title, optional text, one block of fields per item, optional button.
// Many items become ONE message so a burst of new records does not spam the channel.
export function notificationBlocks(o: { title: string; text?: string; items?: NotifyItem[]; url?: string; urlLabel?: string }) {
  const blocks: any[] = [{ type: 'header', text: { type: 'plain_text', text: o.title.slice(0, 150) } }];
  if (o.text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: o.text.slice(0, 2900) } });
  const items = o.items || [];
  for (const it of items.slice(0, 10)) {
    const head = it.title ? (it.url ? `*<${it.url}|${esc(it.title)}>*` : `*${esc(it.title)}*`) : '';
    const rows = Object.entries(it.fields || {}).slice(0, 10).map(([k, v]) => `*${esc(k)}:* ${esc(v)}`).join('\n');
    const body = [head, rows].filter(Boolean).join('\n');
    if (body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body.slice(0, 2900) } });
  }
  if (items.length > 10) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `and ${items.length - 10} more` }] });
  if (o.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: (o.urlLabel || 'Open').slice(0, 75) }, url: o.url }] });
  return blocks;
}
