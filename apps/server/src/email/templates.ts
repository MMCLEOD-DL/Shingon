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

/** Only web links may become a button target; anything else is shown as text only. */
function safeHref(link: string): string | null {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function layout(appName: string, paragraphs: string[], button?: { label: string; link: string }): string {
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2933;">${escapeHtml(s)}</p>`;
  const href = button ? safeHref(button.link) : null;
  const btn = button && href
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;background:#1c5d99;color:#ffffff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:600;">${escapeHtml(button.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52606d;">If the button does not work, copy this address into your browser: ${escapeHtml(button.link)}</p>`
    : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(appName)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:560px;margin:0 auto;padding:32px;background:#ffffff;border-radius:8px;">` +
    `<h1 style="margin:0 0 24px;font-size:20px;color:#1f2933;">${escapeHtml(appName)}</h1>${paragraphs.map(p).join('')}${btn}</div></body></html>`;
}

export function renderTemplate(name: TemplateName, data: Record<string, string>, site: Site): RenderedMail {
  const { appName } = site;
  const v = (k: string) => data[k] ?? '';
  switch (name) {
    case 'invite': {
      const lines = [`Hello ${v('name')},`, `${v('inviterName')} has invited you to ${appName}.`, 'Use the link below to choose your password and sign in.'];
      const note = 'This link works for 7 days.';
      return {
        subject: `${v('inviterName')} invited you to ${appName}`,
        text: `${lines.join('\n\n')}\n\n${v('link')}\n\n${note}\n`,
        html: layout(appName, [...lines, note], { label: 'Accept the invitation', link: v('link') }),
      };
    }
    case 'password-reset': {
      const lines = [`Hello ${v('name')},`, `We received a request to reset your ${appName} password.`, 'Use the link below to choose a new one. If you did not ask for this, you can ignore this email and your password will stay the same.'];
      const note = 'This link works for 1 hour and only once.';
      return {
        subject: `Reset your ${appName} password`,
        text: `${lines.join('\n\n')}\n\n${v('link')}\n\n${note}\n`,
        html: layout(appName, [...lines, note], { label: 'Reset your password', link: v('link') }),
      };
    }
    case 'password-changed': {
      const lines = [`Hello ${v('name')},`, `Your ${appName} password was just changed, and you have been signed out everywhere.`, 'If this was you, there is nothing more to do. If it was not, ask your administrator for help straight away.'];
      return {
        subject: `Your ${appName} password was changed`,
        text: `${lines.join('\n\n')}\n`,
        html: layout(appName, lines),
      };
    }
  }
}
