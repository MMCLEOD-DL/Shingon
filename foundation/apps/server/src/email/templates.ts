export type TemplateName = 'invite' | 'password-reset' | 'password-changed';

export interface Site { appName: string; appOrigin: string }
export interface RenderedMail { subject: string; text: string; html: string }

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Only web links to this app's own origin may become a button target; anything else is shown as text only. */
function safeHref(link: string, appOrigin: string): string | null {
  try {
    const u = new URL(link);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(appOrigin).origin ? u.href : null;
  } catch {
    return null;
  }
}

function layout(site: Site, paragraphs: string[], button?: { label: string; link: string }): string {
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2933;">${escapeHtml(s)}</p>`;
  const { appName } = site;
  const href = button ? safeHref(button.link, site.appOrigin) : null;
  const btn = button && href
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;background:#1c5d99;color:#ffffff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:600;">${escapeHtml(button.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52606d;">If the button does not work, copy this address into your browser: ${escapeHtml(button.link)}</p>`
    : button
      ? `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52606d;">${escapeHtml(button.link)}</p>`
      : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(appName)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;">` +
    `<h1 style="margin:0 0 24px;font-size:20px;color:#1f2933;">${escapeHtml(appName)}</h1>${paragraphs.map(p).join('')}${btn}</div></body></html>`;
}

export function renderTemplate(name: TemplateName, data: Record<string, string>, site: Site): RenderedMail {
  const { appName } = site;
  const required: Record<TemplateName, string[]> = {
    invite: ['name', 'inviterName', 'link'],
    'password-reset': ['name', 'link'],
    'password-changed': ['name'],
  };
  if (!Object.hasOwn(required, name)) throw new Error(`Unknown email template "${name as string}".`);
  const missing = required[name].filter((k) => typeof data[k] !== 'string' || data[k] === '');
  if (missing.length > 0) throw new Error(`The ${name} email is missing: ${missing.join(', ')}.`);
  const v = (k: string) => data[k] ?? '';
  switch (name) {
    case 'invite': {
      const lines = [`Hello ${v('name')},`, `${v('inviterName')} has invited you to ${appName}.`, 'Use the link below to choose your password and sign in.'];
      const note = 'This link works for 7 days.';
      return {
        subject: `${v('inviterName')} invited you to ${appName}`,
        text: `${lines.join('\n\n')}\n\n${v('link')}\n\n${note}\n`,
        html: layout(site, [...lines, note], { label: 'Accept the invitation', link: v('link') }),
      };
    }
    case 'password-reset': {
      const lines = [`Hello ${v('name')},`, `We received a request to reset your ${appName} password.`, 'Use the link below to choose a new one. If you did not ask for this, you can ignore this email and your password will stay the same.'];
      const note = 'This link works for 1 hour and only once.';
      return {
        subject: `Reset your ${appName} password`,
        text: `${lines.join('\n\n')}\n\n${v('link')}\n\n${note}\n`,
        html: layout(site, [...lines, note], { label: 'Reset your password', link: v('link') }),
      };
    }
    case 'password-changed': {
      // scope 'others': changed from inside the app, so the session in use stays signed in.
      const signedOut = data['scope'] === 'others' ? 'your other sessions have been signed out' : 'you have been signed out everywhere';
      const lines = [`Hello ${v('name')},`, `Your ${appName} password was just changed, and ${signedOut}.`, 'If this was you, there is nothing more to do. If it was not, ask your administrator for help straight away.'];
      return {
        subject: `Your ${appName} password was changed`,
        text: `${lines.join('\n\n')}\n`,
        html: layout(site, lines),
      };
    }
  }
}
