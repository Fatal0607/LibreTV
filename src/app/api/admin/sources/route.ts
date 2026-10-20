import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { ADMIN_GLOBAL_LIMIT_KEY, checkAdminPassword, isAdminConfigured } from '@/lib/admin-auth';
import { checkRateLimit, clearRateLimit } from '@/lib/auth';
import { normalizeServerSources, readServerSources, writeServerSources } from '@/lib/server-sources';

export const runtime = 'nodejs';

/** 请求体上限：100 个点播源 + 50 个直播源正常只有几十 KB */
const MAX_BODY_BYTES = 512 * 1024;

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

/** 查看当前全站共享源（登录即可查看） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json({ adminConfigured: isAdminConfigured(), ...readServerSources() });
}

/** 用提交的列表整体替换全站共享源（需要管理密码） */
export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  if (!isAdminConfigured()) {
    return jsonError('服务器未设置 ADMIN_PASSWORD，无法修改全站共享源', 503);
  }

  // 与登录接口共用限流表，key 加前缀互不影响。
  // 按 IP 之外再叠一个全局桶：X-Forwarded-For 可被客户端伪造（反代未覆盖时），
  // 只按 IP 限流会被换 IP 头无限猜管理密码
  const ipKey = `admin:${clientIp(req)}`;
  if (!checkRateLimit(ipKey) || !checkRateLimit(ADMIN_GLOBAL_LIMIT_KEY)) {
    return jsonError('尝试次数过多，请 10 分钟后再试', 429);
  }

  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) return jsonError('提交内容过大', 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return jsonError('提交内容过大', 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  const adminPassword = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).adminPassword : undefined;
  if (typeof adminPassword !== 'string' || !checkAdminPassword(adminPassword)) {
    return jsonError('管理密码错误', 403);
  }
  clearRateLimit(ipKey);
  clearRateLimit(ADMIN_GLOBAL_LIMIT_KEY);

  const payload = normalizeServerSources(raw);
  if (!payload) return jsonError('源列表格式不正确', 400);

  try {
    const saved = writeServerSources(payload);
    return NextResponse.json({
      success: true,
      sources: saved.sources.length,
      liveSources: saved.liveSources.length,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    console.error('[LibreTV] 写入全站共享源失败：', err);
    return jsonError('服务器保存失败，请检查数据目录是否可写', 500);
  }
}
