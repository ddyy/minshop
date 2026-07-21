import type { APIRoute } from 'astro';
import { getEmailProvider } from '../../../../features/email';
import { getStoreSettings } from '../../../../features/settings/db';
import { env } from 'cloudflare:workers';

export const prerender = false;

// POST /api/admin/email/test — send a one-off test email with the CURRENTLY SAVED
// email config (provider + key + from), so the owner can confirm delivery actually
// works (the only way past "binding present ≠ deliverable"). Returns JSON for the
// dashboard's inline button; falls back to a ?msg redirect without JS.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const to = String(form.get('test_to') ?? '').trim();
  const wantsJson = request.headers.get('x-requested-with') === 'fetch';
  const done = (ok: boolean, message: string) =>
    wantsJson
      ? new Response(JSON.stringify({ ok, message }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      : redirect(`/admin/settings?msg=${encodeURIComponent(message)}#email`, 303);

  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return done(false, 'Enter a valid recipient address for the test email.');
  }
  const provider = await getEmailProvider();
  if (!provider) {
    return done(false, 'Email isn’t configured — pick a provider, add its key, and Save first.');
  }
  const storeName = (await getStoreSettings(env.DB)).storeName ?? 'your store';
  try {
    await provider.send({
      to,
      subject: `Test email from ${storeName}`,
      html: `<p>This is a test email from your ${storeName} admin. Email delivery is working ✅</p>`,
      text: `This is a test email from your ${storeName} admin. Email delivery is working.`,
    });
    return done(true, `Test email sent to ${to}.`);
  } catch (err) {
    return done(false, `Send failed: ${(err as Error).message || 'unknown error'}`);
  }
};
