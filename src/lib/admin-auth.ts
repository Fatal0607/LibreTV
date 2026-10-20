import crypto from 'node:crypto';

/**
 * 管理密码（anericn 定制）：与访问密码 PASSWORD 分开，只用于修改全站共享源。
 * 知道访问密码的人只能使用站点，不能改动所有人看到的源列表。
 */

/** 全站共用的管理密码尝试次数桶（与按 IP 的桶叠加，防伪造 IP 头绕过限流） */
export const ADMIN_GLOBAL_LIMIT_KEY = 'admin:global';

export function isAdminConfigured(): boolean {
  return (process.env.ADMIN_PASSWORD || '').length > 0;
}

/** 恒定时间比较（比较 sha256 摘要避免长度泄漏）；未配置管理密码时一律拒绝 */
export function checkAdminPassword(input: string): boolean {
  const admin = process.env.ADMIN_PASSWORD || '';
  if (!admin) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(admin).digest();
  return crypto.timingSafeEqual(a, b);
}
