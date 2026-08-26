import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { authenticateMemberCode, signMemberSession } from '../../features/auth/member';
import { getStoreSettings } from '../../features/settings/db';
import { memberAccessMode } from '../../features/auth/memberAccess';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const settings = await getStoreSettings(env.DB);
  if (memberAccessMode(settings) === 'off') {
    return redirect('/', 303);
  }
  const form = await request.formData();
  const code = String(form.get('code') ?? '').trim();
  const nextRaw = String(form.get('next') ?? '').trim();
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/';
  const secret = env.AUTH_SECRET;
  if (!secret) return new Response('Member access is not configured.', { status: 503 });
  const id = code && code.length <= 256 ? await authenticateMemberCode(env.DB, code) : null;
  if (!id) return redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
  const url = new URL(request.url);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  cookies.set('member_session', await signMemberSession(id, secret), {
    httpOnly: true,
    secure: !loopback,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return redirect(next, 303);
};
