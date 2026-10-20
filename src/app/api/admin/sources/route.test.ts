import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET, PUT } from './route';
import { ADMIN_GLOBAL_LIMIT_KEY } from '@/lib/admin-auth';
import { SESSION_COOKIE, clearRateLimit, signSession } from '@/lib/auth';
import { readServerSources } from '@/lib/server-sources';

/**
 * 全站共享源接口单测：登录守卫、管理密码校验与限流、未配置管理密码、写入与读回。
 */

const ADMIN = 'admin-secret-1';
let dataDir: string;
let ipSeq = 0;

function makeRequest(method: 'GET' | 'PUT', body?: unknown, options?: { authenticated?: boolean; ip?: string }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-real-ip': options?.ip ?? `10.0.0.${++ipSeq}` };
  if (options?.authenticated !== false) {
    headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  }
  return new Request('https://local.test/api/admin/sources', {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = {
  adminPassword: ADMIN,
  sources: [{ name: '共享A', url: 'https://a.example.com/api.php/provide/vod' }],
  liveSources: [{ name: '直播A', url: 'https://l.example.com/a.m3u' }],
};

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-admin-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = ADMIN;
  clearRateLimit(ADMIN_GLOBAL_LIMIT_KEY);
});

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_PASSWORD;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/admin/sources', () => {
  it('未登录被拦下', async () => {
    const res = await GET(makeRequest('GET', undefined, { authenticated: false }));
    expect(res.status).toBe(401);
  });

  it('返回当前共享源与是否配置了管理密码', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ adminConfigured: true, sources: [], liveSources: [], updatedAt: null });
  });
});

describe('PUT /api/admin/sources', () => {
  it('未登录被拦下，且不写盘', async () => {
    const res = await PUT(makeRequest('PUT', VALID, { authenticated: false }));
    expect(res.status).toBe(401);
    expect(readServerSources().updatedAt).toBeNull();
  });

  it('未配置 ADMIN_PASSWORD 时返回 503', async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await PUT(makeRequest('PUT', VALID));
    expect(res.status).toBe(503);
  });

  it('管理密码错误返回 403，且不写盘', async () => {
    const res = await PUT(makeRequest('PUT', { ...VALID, adminPassword: 'wrong' }));
    expect(res.status).toBe(403);
    expect(readServerSources().updatedAt).toBeNull();
  });

  it('同一 IP 连续输错超过上限后返回 429', async () => {
    const ip = '192.168.9.9';
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await PUT(makeRequest('PUT', { ...VALID, adminPassword: 'wrong' }, { ip }))).status;
    }
    expect(last).toBe(429);
  });

  it('换 IP 头也绕不过：全局累计输错超过上限后返回 429', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await PUT(makeRequest('PUT', { ...VALID, adminPassword: 'wrong' }))).status;
    }
    expect(last).toBe(429);
  });

  it('Content-Length 超限直接返回 413', async () => {
    const req = makeRequest('PUT', VALID);
    const big = new Request(req, { headers: { ...Object.fromEntries(req.headers), 'content-length': String(10 * 1024 * 1024) } });
    const res = await PUT(big);
    expect(res.status).toBe(413);
  });

  it('请求体不是合法 JSON 返回 400', async () => {
    const res = await PUT(makeRequest('PUT', 'not json'));
    expect(res.status).toBe(400);
  });

  it('结构不对返回 400', async () => {
    const res = await PUT(makeRequest('PUT', { adminPassword: ADMIN, sources: 'x' }));
    expect(res.status).toBe(400);
  });

  it('密码正确时整体替换共享源并返回条数', async () => {
    const res = await PUT(makeRequest('PUT', VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, sources: 1, liveSources: 1 });
    expect(readServerSources().sources).toEqual([{ name: '共享A', url: 'https://a.example.com/api.php/provide/vod' }]);
    // 管理密码不能被落盘
    expect(fs.readFileSync(path.join(dataDir, 'server-sources.json'), 'utf8')).not.toContain(ADMIN);
  });

  it('可以提交空列表清空共享源', async () => {
    await PUT(makeRequest('PUT', VALID));
    const res = await PUT(makeRequest('PUT', { adminPassword: ADMIN, sources: [], liveSources: [] }));
    expect(res.status).toBe(200);
    expect(readServerSources().sources).toEqual([]);
  });
});
