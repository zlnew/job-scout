// Source adapters. All HTTP, no SDKs, no dependencies.
//
// fungsi.id — Indonesian job index exposed as an MCP server (streamable HTTP,
// read-only, no key). Verified live: tools search_jobs/get_job/get_company.
//
// Gmail — used for stage 3 only (create a draft; never send). Credentials live
// outside the repo; the path comes from the environment.
import fs from 'node:fs';
import path from 'node:path';

const FUNGSI_URL = process.env.FUNGSI_MCP_URL || 'https://api.fungsi.id/mcp';
const GMAIL_DIR = process.env.GMAIL_MCP_DIR || '/home/nova/www/secret/gmail_mcp';

// ---------- MCP client (just enough JSON-RPC, nothing to install) ----------

let sessionReady = false;

async function rpc(body) {
  const res = await fetch(FUNGSI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try {
        json = JSON.parse(line.slice(5).trim());
      } catch {}
    }
  }
  if (!json) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  return json;
}

async function ensureSession() {
  if (sessionReady) return;
  await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'job-scout', version: '2.0.0' },
    },
  });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sessionReady = true;
}

async function callTool(name, args) {
  await ensureSession();
  const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: args } });
  const text = res?.result?.content?.[0]?.text;
  if (!text) throw new Error(`fungsi ${name} returned no content`);
  return JSON.parse(text);
}

// ---------- fungsi.id ----------

function toPosting(job, detail) {
  const d = detail || {};
  const description = typeof d.description === 'string' ? d.description : '';
  return {
    source: 'fungsi',
    slug: d.slug || job.slug,
    title: d.title || job.title,
    company: d.company?.name || job.company,
    company_slug: d.company?.slug || job.company_slug,
    location: d.location || [d.city, d.province].filter(Boolean).join(', ') || job.city,
    city: d.city || job.city,
    remote: d.remote ?? job.remote ?? false,
    salary: d.salary ?? job.salary ?? null,
    type: d.type ?? null,
    categories: d.categories ?? [],
    published: d.published ?? job.published ?? null,
    url: d.url || job.url,
    description: description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000),
  };
}

/**
 * Search the fungsi.id index and hydrate each hit with its full description.
 * Descriptions matter: the scorer reads stack and domain signals out of them.
 */
export async function scanFungsi(searches, { details = true, delayMs = 250 } = {}) {
  const seen = new Map();
  for (const s of searches) {
    const page = await callTool('search_jobs', { ...s, page: s.page || 1 });
    for (const job of page?.jobs || []) {
      if (!seen.has(job.slug)) seen.set(job.slug, job);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const posts = [];
  for (const [slug, job] of seen) {
    if (!details) {
      posts.push(toPosting(job));
      continue;
    }
    try {
      const detail = await callTool('get_job', { slug });
      posts.push(toPosting(job, detail));
    } catch {
      posts.push(toPosting(job));
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return posts;
}

export async function fungsiCategories() {
  return callTool('list_categories', {});
}

// ---------- Gmail (draft only) ----------

function gmailCreds() {
  const credFile = path.join(GMAIL_DIR, 'credentials.json');
  if (!fs.existsSync(credFile)) {
    throw new Error(`Gmail credentials not found at ${credFile}. Set GMAIL_MCP_DIR.`);
  }
  const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const keyFile = fs.readdirSync(GMAIL_DIR).find((f) => f.startsWith('client_secret_'));
  if (!keyFile) throw new Error(`No client_secret_*.json in ${GMAIL_DIR}`);
  const raw = JSON.parse(fs.readFileSync(path.join(GMAIL_DIR, keyFile), 'utf8'));
  const client = raw.installed || raw.web;
  return { refreshToken: cred.tokens?.refresh_token, client };
}

export async function gmailToken() {
  const { refreshToken, client } = gmailCreds();
  if (!refreshToken) throw new Error('No refresh token in credentials.json — re-run the OAuth flow.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Gmail token refresh failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

/**
 * Create a Gmail draft with the CV attached. Deliberately no send function:
 * an application leaves the account only when a human presses send.
 */
export async function createGmailDraft({ to, cc, bcc, subject, body, attachmentPath, attachmentName }) {
  const token = await gmailToken();
  const hasFile = attachmentPath && fs.existsSync(attachmentPath);
  const b64 = (buf) =>
    Buffer.from(buf)
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n');

  // Address headers: To is required, Cc/Bcc only appear when the caller supplied one.
  const addressHeaders = [`To: ${to}`];
  if (cc) addressHeaders.push(`Cc: ${cc}`);
  if (bcc) addressHeaders.push(`Bcc: ${bcc}`);

  let mime;
  if (!hasFile) {
    mime = [
      ...addressHeaders,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.from(body, 'utf8')),
      '',
    ].join('\r\n');
  } else {
    const boundary = `----jobapply_${Date.now()}`;
    mime = [
      ...addressHeaders,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.from(body, 'utf8')),
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachmentName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachmentName}"`,
      '',
      b64(fs.readFileSync(attachmentPath)),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Draft creation failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  return { draftId: json.id, threadId: json.message?.threadId };
}
