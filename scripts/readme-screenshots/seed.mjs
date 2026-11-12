// Builds a fictional sandbox for README screenshots:
//   home/code/acme/acme-*   real git repos with history, feature branches,
//                           unpushed commits and uncommitted edits
//   home/remotes/*.git      bare "origin" repos the clones were seeded from;
//                           afterwards origin is repointed at a fictional
//                           github.com/acme-co URL and https is disabled in
//                           the sandbox gitconfig, so nothing reaches a network
//   home/bin/gh             stub gh that serves canned PR + CI JSON
//   userData/overgit.json   repos, workspaces and worksets pointing at all that
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';

// Usage: node seed.mjs <workDir> <userDataDir> [dark|light]
const [ROOT, USERDATA, THEME = 'dark'] = process.argv.slice(2);
if (!ROOT || !USERDATA) throw new Error('usage: node seed.mjs <workDir> <userDataDir> [dark|light]');
const HOME = path.join(ROOT, 'home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const realHome = fs.realpathSync(HOME);
const CODE = path.join(realHome, 'code', 'acme');
const REMOTES = path.join(realHome, 'remotes');
const BIN = path.join(realHome, 'bin');
fs.mkdirSync(CODE, { recursive: true });
fs.mkdirSync(REMOTES, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

// Sandbox identity and network lockout. Every git the app spawns runs with
// HOME=realHome, so this is the only global config it sees.
fs.writeFileSync(
  path.join(realHome, '.gitconfig'),
  `[user]
\tname = Dana Reyes
\temail = dana@acme.dev
[init]
\tdefaultBranch = main
[protocol "https"]
\tallow = never
[protocol "http"]
\tallow = never
[protocol "ssh"]
\tallow = never
[advice]
\tdetachedHead = false
`,
);

const PEOPLE = {
  dana: ['Dana Reyes', 'dana@acme.dev'],
  sam: ['Sam Okafor', 'sam@acme.dev'],
  priya: ['Priya Nair', 'priya@acme.dev'],
  leo: ['Leo Martin', 'leo@acme.dev'],
};

const now = Date.now();
const env = (who = 'dana', hoursAgo = 0) => {
  const [name, email] = PEOPLE[who];
  const date = new Date(now - hoursAgo * 3600_000).toISOString();
  return {
    ...process.env,
    HOME: realHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
};
const git = (cwd, args, who, hoursAgo) => execFileSync('git', args, { cwd, stdio: 'pipe', env: env(who, hoursAgo) }).toString();

function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body.replace(/^\n/, ''));
  }
}

function commit(dir, msg, files, who = 'dana', hoursAgo = 0) {
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], who, hoursAgo);
}

/// A repo with a bare origin, `main` pushed and tracking, origin/HEAD set.
/// `history` entries are [message, files, who, hoursAgo], oldest first.
function repo(name, history) {
  const bare = path.join(REMOTES, `${name}.git`);
  git(REMOTES, ['init', '-q', '--bare', '-b', 'main', bare]);
  const dir = path.join(CODE, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [msg, files, who, h] of history) commit(dir, msg, files, who, h);
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  git(dir, ['remote', 'set-head', 'origin', 'main']);
  return dir;
}

/// A teammate lands commits on origin/<branch> from their own clone; the
/// local repo fetches, so it now sees itself as behind.
function teammatePush(name, branch, commits) {
  const tmp = path.join(ROOT, 'teammate', name);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  git(ROOT, ['clone', '-q', '-b', branch, path.join(REMOTES, `${name}.git`), tmp]);
  for (const [msg, files, who, h] of commits) commit(tmp, msg, files, who, h);
  git(tmp, ['push', '-q', 'origin', branch]);
  git(path.join(CODE, name), ['fetch', '-q', 'origin']);
}

function branch(dir, name, commits, { push = true } = {}) {
  git(dir, ['switch', '-q', '-c', name]);
  for (const [msg, files, who, h] of commits) commit(dir, msg, files, who, h);
  if (push) git(dir, ['push', '-q', '-u', 'origin', name]);
}

// ------------------------------------------------------------------ repos

const ORDERS_V1 = `
import { Router } from 'express';
import { listOrders, getOrder } from '../services/orders';

export const orders = Router();

orders.get('/', async (req, res) => {
  const page = Number(req.query.page ?? 1);
  res.json(await listOrders({ page, pageSize: 50 }));
});

orders.get('/:id', async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  res.json(order);
});
`;

const api = repo('acme-api', [
  ['chore: scaffold express service', {
    'package.json': JSON.stringify({ name: 'acme-api', private: true, scripts: { dev: 'tsx watch src/server.ts', test: 'vitest run' } }, null, 2) + '\n',
    'README.md': '# acme-api\n\nPublic REST API for orders, carts and promos.\n',
    'src/server.ts': "import express from 'express';\nimport { orders } from './routes/orders';\n\nconst app = express();\napp.use('/v2/orders', orders);\napp.listen(Number(process.env.PORT ?? 3000));\n",
    'src/services/orders.ts': 'export async function listOrders(_q: { page: number; pageSize: number }) {\n  return [];\n}\nexport async function getOrder(_id: string) {\n  return null;\n}\n',
  }, 'sam', 24 * 40],
  ['feat(orders): paginated order list', { 'src/routes/orders.ts': ORDERS_V1 }, 'sam', 24 * 30],
  ['feat(promos): promo lookup service', { 'src/services/promos.ts': 'export async function findPromo(code: string) {\n  return code === \'SPRING15\' ? { code, percentOff: 15 } : null;\n}\n' }, 'priya', 24 * 12],
  ['fix(orders): 404 body matches the error schema', { 'src/routes/orders.ts': ORDERS_V1.replace("{ error: 'not_found' }", "{ error: { code: 'not_found' } }") }, 'leo', 24 * 6],
]);

const gateway = repo('acme-gateway', [
  ['chore: envoy front proxy', {
    'README.md': '# acme-gateway\n\nEdge proxy and request policy for every public Acme API.\n',
    'envoy/envoy.yaml': 'static_resources:\n  listeners:\n    - name: public\n      address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }\n',
    'src/policy/index.ts': "export * from './cors';\n",
    'src/policy/cors.ts': "export const ALLOWED_ORIGINS = ['https://shop.acme.dev', 'https://admin.acme.dev'];\n",
  }, 'leo', 24 * 50],
  ['feat(policy): request id on every hop', { 'src/policy/requestId.ts': "import { randomUUID } from 'node:crypto';\nexport const requestId = (h: Headers) => h.get('x-request-id') ?? randomUUID();\n" }, 'leo', 24 * 20],
  ['chore(deps): bump envoy to 1.30', { 'envoy/VERSION': '1.30.2\n' }, 'sam', 24 * 9],
]);

const shared = repo('acme-shared', [
  ['chore: shared config package', {
    'package.json': JSON.stringify({ name: '@acme/shared', version: '3.4.0' }, null, 2) + '\n',
    'README.md': '# acme-shared\n\nConfig schemas and helpers used by every Acme service.\n',
    'src/config/schema.ts': "import { z } from 'zod';\n\nexport const ServiceConfig = z.object({\n  name: z.string(),\n  port: z.number().int(),\n});\n",
  }, 'priya', 24 * 60],
  ['feat(config): typed env loader', { 'src/config/env.ts': "export const env = (key: string, fallback?: string) => process.env[key] ?? fallback;\n" }, 'priya', 24 * 15],
]);

const auth = repo('acme-auth', [
  ['chore: auth service skeleton', {
    'README.md': '# acme-auth\n\nSessions, API keys and OAuth for Acme.\n',
    'src/keys.ts': 'export interface ApiKey {\n  id: string;\n  owner: string;\n  scopes: string[];\n}\n',
  }, 'leo', 24 * 70],
  ['feat(keys): rotate API keys without downtime', { 'src/rotate.ts': 'export async function rotate(_id: string) {}\n' }, 'leo', 24 * 8],
]);

const billing = repo('acme-billing', [
  ['chore: billing service', {
    'README.md': '# acme-billing\n\nInvoices, retries and dunning.\n',
    'src/invoice.ts': 'export interface LineItem {\n  sku: string;\n  qty: number;\n  unitCents: number;\n}\n',
    'jobs/invoice_retry.py': 'BACKOFF_HOURS = [1, 6, 24]\n\ndef run():\n    pass\n',
  }, 'sam', 24 * 45],
  ['feat(invoice): tax lines per region', { 'src/tax.ts': 'export const taxRate = (region: string) => (region === \'EU\' ? 0.2 : 0.0825);\n' }, 'sam', 24 * 11],
]);

const ledger = repo('acme-ledger', [
  ['chore: double-entry ledger core', {
    'README.md': '# acme-ledger\n\nDouble-entry ledger behind every Acme payment.\n',
    'src/entry.ts': 'export interface Entry {\n  debit: string;\n  credit: string;\n  cents: number;\n}\n',
  }, 'priya', 24 * 80],
  ['perf: batch ledger writes', { 'src/batch.ts': 'export const BATCH_SIZE = 500;\n' }, 'priya', 24 * 4],
]);

const storefront = repo('acme-storefront', [
  ['chore: scaffold storefront', {
    'package.json': JSON.stringify({ name: 'acme-storefront', private: true, scripts: { dev: 'vite', test: 'vitest run' } }, null, 2) + '\n',
    'README.md': '# acme-storefront\n\nThe Acme web shop.\n',
    'src/lib/money.ts': "export const formatMoney = (cents: number) =>\n  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);\n",
  }, 'dana', 24 * 55],
  ['feat(checkout): order summary', {
    'src/checkout/CheckoutSummary.tsx': "import { useCart } from '../cart/useCart';\nimport { formatMoney } from '../lib/money';\n\nexport function CheckoutSummary() {\n  const { subtotal, shipping } = useCart();\n  const total = subtotal + shipping;\n  return <p className=\"total\">{formatMoney(total)}</p>;\n}\n",
    'src/cart/useCart.ts': 'export function useCart() {\n  return { items: [], subtotal: 0, shipping: 0 };\n}\n',
  }, 'dana', 24 * 14],
]);

const admin = repo('acme-admin', [
  ['chore: admin console', { 'README.md': '# acme-admin\n\nInternal back office.\n', 'src/export/csv.ts': "export const toCsv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\\n');\n" }, 'leo', 24 * 33],
]);

const uiKit = repo('acme-ui-kit', [
  ['chore: design tokens', { 'README.md': '# acme-ui-kit\n\nShared React components.\n', 'src/tokens.ts': "export const radius = { sm: 4, md: 8 };\n" }, 'dana', 24 * 90],
  ['feat(button): loading state', { 'src/Button.tsx': 'export function Button(p: { loading?: boolean; children: React.ReactNode }) {\n  return <button aria-busy={p.loading}>{p.children}</button>;\n}\n' }, 'dana', 24 * 3],
]);

// ------------------------------------------- workset: rate-limiter rollout

const RL_CONFIG = `
import { z } from 'zod';

/** Token-bucket limits, shared by the gateway and every service behind it. */
export const RateLimit = z.object({
  /** Requests a key may burst before throttling kicks in. */
  burst: z.number().int().positive().default(60),
  /** Tokens refilled per second. */
  refillPerSecond: z.number().positive().default(1),
  /** Seconds a throttled client is told to wait. */
  retryAfter: z.number().int().positive().default(30),
});
export type RateLimit = z.infer<typeof RateLimit>;

export const RATE_LIMIT_DEFAULTS: RateLimit = RateLimit.parse({});
`;

branch(shared, 'feat/rate-limit', [
  ['feat(config): shared RateLimit schema', { 'src/config/rateLimit.ts': RL_CONFIG }, 'dana', 26],
]);
// One more commit that hasn't been pushed yet.
commit(shared, 'docs: document RATE_LIMIT_DEFAULTS', { 'README.md': '# acme-shared\n\nConfig schemas and helpers used by every Acme service.\n\n- `RATE_LIMIT_DEFAULTS` — burst 60, refill 1/s, retry after 30s.\n' }, 'dana', 1);

const BUCKET = `
import { RATE_LIMIT_DEFAULTS, type RateLimit } from '@acme/shared/config/rateLimit';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** In-memory token bucket keyed by API key. One per gateway instance. */
export class TokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(private limit: RateLimit = RATE_LIMIT_DEFAULTS) {}

  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    const b = this.buckets.get(key) ?? { tokens: this.limit.burst, updatedAt: now };
    const refill = ((now - b.updatedAt) / 1000) * this.limit.refillPerSecond;
    b.tokens = Math.min(this.limit.burst, b.tokens + refill);
    b.updatedAt = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return { ok: false, retryAfter: this.limit.retryAfter };
    b.tokens -= 1;
    return { ok: true };
  }
}
`;

branch(gateway, 'feat/rate-limit', [
  ['feat(policy): token-bucket rate limiter', { 'src/policy/rateLimit.ts': BUCKET, 'src/policy/index.ts': "export * from './cors';\nexport * from './rateLimit';\n" }, 'dana', 30],
  ['test(policy): bucket refills over time', { 'src/policy/rateLimit.test.ts': "import { TokenBucket } from './rateLimit';\n\ntest('refills', () => {\n  const b = new TokenBucket({ burst: 1, refillPerSecond: 1, retryAfter: 30 });\n  expect(b.take('k', 0).ok).toBe(true);\n  expect(b.take('k', 0).ok).toBe(false);\n  expect(b.take('k', 1000).ok).toBe(true);\n});\n" }, 'dana', 22],
]);
// Work in progress, uncommitted.
write(gateway, {
  'envoy/envoy.yaml': 'static_resources:\n  listeners:\n    - name: public\n      address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }\n      per_connection_buffer_limit_bytes: 32768\n      # rate limiting happens in src/policy/rateLimit.ts, keyed by API key\n',
  'src/policy/rateLimit.ts': BUCKET.replace('/** In-memory token bucket keyed by API key. One per gateway instance. */', '/**\n * In-memory token bucket keyed by API key. One per gateway instance;\n * RATE_LIMIT_DEFAULTS apply until the key has its own plan.\n */'),
});

const ORDERS_RL = ORDERS_V1.replace(
  "import { listOrders, getOrder } from '../services/orders';",
  "import { listOrders, getOrder } from '../services/orders';\nimport { RATE_LIMIT_DEFAULTS } from '@acme/shared/config/rateLimit';\nimport { limiter } from '../middleware/limiter';",
).replace(
  "orders.get('/', async (req, res) => {\n  const page = Number(req.query.page ?? 1);\n  res.json(await listOrders({ page, pageSize: 50 }));",
  "orders.get('/', limiter(RATE_LIMIT_DEFAULTS), async (req, res) => {\n  const page = Number(req.query.page ?? 1);\n  res.json(await listOrders({ page, pageSize: 25 }));",
);
branch(api, 'feat/rate-limit', [
  ['feat(orders): throttle order listing per API key', {
    'src/middleware/limiter.ts': "import type { RequestHandler } from 'express';\nimport type { RateLimit } from '@acme/shared/config/rateLimit';\n\nexport const limiter = (_limit: RateLimit): RequestHandler => (_req, _res, next) => next();\n",
    'src/routes/orders.ts': ORDERS_RL,
  }, 'dana', 28],
  ['feat(orders): Retry-After header on 429', { 'src/middleware/retryAfter.ts': "export const retryAfter = (seconds: number) => ({ 'Retry-After': String(seconds) });\n" }, 'dana', 20],
]);

// ------------------------------------------- workset: promo codes at checkout

git(api, ['switch', '-q', 'main']);
branch(api, 'feat/promo-codes', [
  ['feat(promos): POST /v2/promos/validate', {
    'src/routes/promos.ts': "import { Router } from 'express';\nimport { findPromo } from '../services/promos';\n\nexport const promos = Router();\n\npromos.post('/validate', async (req, res) => {\n  const promo = await findPromo(String(req.body.code ?? '').toUpperCase());\n  if (!promo) return res.status(404).json({ error: { code: 'unknown_promo' } });\n  res.json({ discountCents: Math.round(req.body.subtotal * (promo.percentOff / 100)) });\n});\n",
    // Also edits the order list, on the same lines feat/rate-limit touched.
    'src/routes/orders.ts': ORDERS_V1.replace("res.json(await listOrders({ page, pageSize: 50 }));", "res.json(await listOrders({ page, pageSize: 50, withPromos: true }));"),
  }, 'priya', 18],
]);
git(api, ['switch', '-q', 'feat/rate-limit']);

// Meanwhile main moved under the rate-limit branch: same lines, different change.
teammatePush('acme-api', 'main', [
  ['perf(orders): smaller default page', { 'src/routes/orders.ts': ORDERS_V1.replace("{ error: 'not_found' }", "{ error: { code: 'not_found' } }").replace('pageSize: 50', 'pageSize: 20') }, 'sam', 5],
]);

branch(storefront, 'feat/promo-codes', [
  ['feat(checkout): promo code field', {
    'src/checkout/PromoCodeField.tsx': "export function PromoCodeField(p: { onApply: (code: string) => void }) {\n  return (\n    <form onSubmit={(e) => { e.preventDefault(); p.onApply(new FormData(e.currentTarget).get('code') as string); }}>\n      <input name=\"code\" placeholder=\"Promo code\" />\n      <button>Apply</button>\n    </form>\n  );\n}\n",
  }, 'priya', 16],
]);
write(storefront, {
  'src/checkout/usePromo.ts': "import { useState } from 'react';\n\nexport function usePromo(subtotal: number) {\n  const [discount, setDiscount] = useState(0);\n  async function apply(code: string) {\n    const res = await fetch('/v2/promos/validate', { method: 'POST', body: JSON.stringify({ code, subtotal }) });\n    setDiscount(res.ok ? (await res.json()).discountCents : 0);\n  }\n  return { discount, apply };\n}\n",
  'src/checkout/CheckoutSummary.tsx': "import { useCart } from '../cart/useCart';\nimport { formatMoney } from '../lib/money';\nimport { usePromo } from './usePromo';\n\nexport function CheckoutSummary() {\n  const { subtotal, shipping } = useCart();\n  const promo = usePromo(subtotal);\n  const total = Math.max(0, subtotal - promo.discount) + shipping;\n  return <p className=\"total\">{formatMoney(total)}</p>;\n}\n",
});

branch(billing, 'feat/promo-codes', [
  ['feat(invoice): discount line items', { 'src/invoice.ts': 'export interface LineItem {\n  sku: string;\n  qty: number;\n  unitCents: number;\n  /** Negative for promo discounts. */\n  discountCents?: number;\n}\n' }, 'priya', 15],
]);

// ------------------------------------------------- other repos, other states

teammatePush('acme-auth', 'main', [
  ['fix(keys): constant-time key comparison', { 'src/compare.ts': "import { timingSafeEqual } from 'node:crypto';\nexport const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);\n" }, 'leo', 7],
  ['chore: log key rotations', { 'src/rotate.ts': "export async function rotate(id: string) {\n  console.info('rotating key', id);\n}\n" }, 'leo', 3],
]);

branch(admin, 'fix/csv-export', [
  ['fix(export): quote fields that contain commas', { 'src/export/csv.ts': "const q = (v: string) => (/[\",\\n]/.test(v) ? `\"${v.replaceAll('\"', '\"\"')}\"` : v);\nexport const toCsv = (rows: string[][]) => rows.map((r) => r.map(q).join(',')).join('\\n');\n" }, 'leo', 9],
]);
write(admin, { 'src/export/csv.test.ts': "import { toCsv } from './csv';\n\ntest('quotes commas', () => expect(toCsv([['a,b']])).toBe('\"a,b\"'));\n" });

// Archived workset leftovers: a merged branch in billing.
git(billing, ['switch', '-q', 'main']);
branch(billing, 'feat/invoice-retries', [
  ['feat(jobs): exponential invoice retries', { 'jobs/invoice_retry.py': 'BACKOFF_HOURS = [1, 6, 24, 72]\n\ndef run():\n    pass\n' }, 'sam', 24 * 20],
]);
git(billing, ['switch', '-q', 'feat/promo-codes']);

// Repoint every origin at a fictional GitHub URL. Fetches now fail fast
// (ssh and https are disallowed above) instead of touching the network, while gh
// detection sees a GitHub remote and asks the stub below for PRs.
const allRepos = { api, gateway, shared, auth, billing, ledger, storefront, admin, uiKit };
for (const dir of Object.values(allRepos)) {
  git(dir, ['remote', 'set-url', 'origin', `git@github.com:acme-co/${path.basename(dir)}.git`]);
}
fs.rmSync(path.join(ROOT, 'teammate'), { recursive: true, force: true });

// ---------------------------------------------------------------- stub gh

const iso = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString();
const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion: status === 'COMPLETED' ? conclusion : '' });
const pr = (repoName, number, title, head, author, hoursAgo, checks, reviewDecision, isDraft = false) => ({
  number,
  title,
  url: `https://github.com/acme-co/${repoName}/pull/${number}`,
  headRefName: head,
  baseRefName: 'main',
  isDraft,
  author: { login: author },
  updatedAt: iso(hoursAgo),
  state: 'OPEN',
  statusCheckRollup: checks,
  reviewDecision,
});
const PRS = {
  'acme-gateway': [
    pr('acme-gateway', 214, 'Token-bucket rate limiter at the edge', 'feat/rate-limit', 'dana-reyes', 3, [run('build', 'SUCCESS'), run('test', 'SUCCESS'), run('lint', 'SUCCESS')], 'APPROVED'),
    pr('acme-gateway', 209, 'Bump envoy to 1.31', 'chore/envoy-1.31', 'sam-okafor', 30, [run('build', 'SUCCESS'), run('test', 'SUCCESS')], 'REVIEW_REQUIRED'),
  ],
  'acme-api': [
    pr('acme-api', 412, 'Throttle order listing and send Retry-After on 429', 'feat/rate-limit', 'dana-reyes', 1, [run('build', 'SUCCESS'), run('test', '', 'IN_PROGRESS'), run('contract-tests', '', 'QUEUED')], 'REVIEW_REQUIRED'),
    pr('acme-api', 415, 'POST /v2/promos/validate', 'feat/promo-codes', 'priya-nair', 6, [run('build', 'SUCCESS'), run('test', 'SUCCESS')], 'APPROVED'),
  ],
  'acme-shared': [
    pr('acme-shared', 88, 'Shared RateLimit config schema', 'feat/rate-limit', 'dana-reyes', 2, [run('build', 'SUCCESS'), run('lint', 'FAILURE'), run('test', 'SUCCESS')], 'CHANGES_REQUESTED'),
  ],
  'acme-storefront': [
    pr('acme-storefront', 530, 'Promo code field at checkout', 'feat/promo-codes', 'priya-nair', 4, [run('build', 'SUCCESS'), run('e2e', '', 'IN_PROGRESS')], 'REVIEW_REQUIRED', true),
  ],
  'acme-billing': [
    pr('acme-billing', 301, 'Discount line items on invoices', 'feat/promo-codes', 'priya-nair', 8, [run('build', 'SUCCESS'), run('test', 'SUCCESS')], 'APPROVED'),
  ],
  'acme-auth': [
    pr('acme-auth', 77, 'Scope API keys to a single environment', 'feat/key-scopes', 'leo-martin', 50, [run('build', 'SUCCESS')], 'REVIEW_REQUIRED'),
  ],
};
const FIX = path.join(realHome, '.gh-fixtures');
fs.mkdirSync(FIX, { recursive: true });
for (const [name, list] of Object.entries(PRS)) fs.writeFileSync(path.join(FIX, `${name}.json`), JSON.stringify(list));

// Answers --version (so the app treats gh as installed) and `pr list` from
// the fixtures; everything else fails the way an offline gh would.
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.62.0 (2024-11-14)"; exit 0 ;;
esac
if [ "$1" = pr ] && [ "$2" = list ]; then
  f="${FIX}/$(basename "$PWD").json"
  if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi
  exit 0
fi
if [ "$1" = pr ] && [ "$2" = view ]; then echo "no pull requests found for branch" >&2; exit 1; fi
echo "gh: offline in the screenshot sandbox" >&2
exit 1
`,
  { mode: 0o755 },
);
// LLM CLIs: present (so review/suggest show) but never do anything.
for (const tool of ['claude', 'codex']) {
  fs.writeFileSync(path.join(BIN, tool), `#!/bin/sh\n[ "$1" = --version ] && { echo "1.0.0"; exit 0; }\necho "${tool}: offline in the screenshot sandbox" >&2\nexit 1\n`, { mode: 0o755 });
}
// The app finds git through PATH, which capture.mjs restricts to BIN plus
// system dirs, so link the git the seed itself used.
const gitPath = execSync('command -v git', { encoding: 'utf8' }).trim();
fs.symlinkSync(fs.realpathSync(gitPath), path.join(BIN, 'git'));

// ---------------------------------------------------------------- store

const uid = () => crypto.randomUUID();
const R = {};
for (const [key, dir] of Object.entries(allRepos)) {
  R[key] = { id: uid(), name: path.basename(dir), path: dir, defaultBranch: 'main', lastOpenedAt: iso(Math.random() * 48) };
}
const workspace = (name, keys, hoursAgo) => ({ id: uid(), name, repoIds: keys.map((k) => R[k].id), createdAt: iso(hoursAgo) });
const workset = (name, keys, preferredBranch, hoursAgo, extra = {}) => ({
  id: uid(),
  name,
  repoIds: keys.map((k) => R[k].id),
  preferredBranch,
  createdAt: iso(hoursAgo),
  ...extra,
});

const rateLimit = workset('Rate-limiter rollout', ['gateway', 'api', 'shared'], 'feat/rate-limit', 40);
const promo = workset('Promo codes at checkout', ['storefront', 'api', 'billing'], 'feat/promo-codes', 20);
const retries = workset('Invoice retries', ['billing'], 'feat/invoice-retries', 24 * 25, { archived: true, archivedAt: iso(24 * 12) });

const state = {
  repos: Object.values(R),
  workspaces: [
    workspace('Platform', ['gateway', 'api', 'auth', 'shared'], 24 * 90),
    workspace('Payments', ['billing', 'ledger', 'shared'], 24 * 80),
    workspace('Web', ['storefront', 'admin', 'uiKit'], 24 * 70),
  ],
  worksets: [rateLimit, promo, retries],
  settings: {
    theme: THEME,
    uiScale: 1,
    sidebarVisible: true,
    sidebarWidth: 300,
    historyAsideWidth: 520,
    changesAsideWidth: 380,
    worksetLastSeen: { [rateLimit.id]: iso(12), [promo.id]: iso(12) },
    stagingMode: 'simple',
    explainMode: false,
    gettingStartedDismissed: true,
  },
};
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });
fs.writeFileSync(path.join(USERDATA, 'overgit.json'), JSON.stringify(state, null, 2));
fs.writeFileSync(
  path.join(ROOT, 'seed-ids.json'),
  JSON.stringify({ home: realHome, bin: BIN, rateLimit: rateLimit.id, promo: promo.id }, null, 2),
);
