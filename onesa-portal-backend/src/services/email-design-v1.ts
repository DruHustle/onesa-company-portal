/** Onesa email design 1.0.0. Pure, deterministic and dependency-free.
 * Retain this renderer for persisted attempts; introduce a new version to revise it.
 * All input is text. Actions require a separately trusted HTTPS origin. */
export type EmailDesign = {
  product: string; category: string; title: string; preview: string; paragraphs: string[];
  status?: {label: string; tone: 'info'|'warning'|'success'};
  action?: {label: string; url: string; origin: string};
  code?: string; details?: {label: string; value: string}[];
  note?: string; footer: string[]; brandCid?: 'onesa-company-logo';
};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const copy = (value: string) => escape(value).replaceAll('\n','<br>');
const font = 'Arial, Helvetica, sans-serif';

export function renderEmailV1(message: EmailDesign): string {
  let action = '';
  if (message.action) {
    const target = new URL(message.action.url), origin = new URL(message.action.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || target.origin !== origin.origin || target.username || target.password || /[\r\n]/.test(message.action.url)) throw new Error('Untrusted email action');
    const url = escape(message.action.url);
    action = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="action" style="margin:28px 0;"><tr><td bgcolor="#2366d1" style="border-radius:8px;mso-padding-alt:16px 26px;"><a href="${url}" style="display:inline-block;background-color:#2366d1;border:1px solid #2366d1;border-radius:8px;padding:16px 26px;font-family:${font};font-size:16px;line-height:22px;font-weight:bold;text-decoration:none;color:#ffffff;">${escape(message.action.label)} &nbsp;→</a></td></tr></table>`;
  }
  const colors = {info:['#eaf4fa','#1d5275'],warning:['#fff0d6','#684110'],success:['#e6f5ec','#14552d']} as const;
  const status = message.status ? `<span class="status-${message.status.tone}" style="display:inline-block;padding:7px 11px;border-radius:4px;background-color:${colors[message.status.tone][0]};color:${colors[message.status.tone][1]};font-size:12px;line-height:18px;font-weight:bold;">${escape(message.status.label)}</span>` : '';
  const details = message.details?.length ? `<table class="details" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0;border-top:1px solid #dae1e9;">${message.details.map(row=>`<tr><th scope="row" class="muted detail-cell" width="34%" align="left" valign="top" style="padding:13px 12px 13px 0;border-bottom:1px solid #dae1e9;color:#56677b;font-size:13px;line-height:20px;font-weight:normal;">${escape(row.label)}</th><td class="copy detail-cell" valign="top" style="padding:13px 0;border-bottom:1px solid #dae1e9;color:#10263e;font-size:13px;line-height:20px;overflow-wrap:anywhere;word-break:break-word;">${copy(row.value)}</td></tr>`).join('')}</table>` : '';
  const code = message.code ? `<div class="code" style="margin:26px 0;padding:22px 18px;background-color:#f5f7fa;border:1px solid #dae1e9;border-radius:8px;text-align:center;"><p class="muted" style="margin:0 0 10px;color:#56677b;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;">Your single-use code</p><p class="copy" style="margin:0;color:#10263e;font-family:Consolas,monospace;font-size:${message.code.length<=8?'32':'17'}px;line-height:1.6;letter-spacing:${message.code.length<=8?'6':'1'}px;overflow-wrap:anywhere;word-break:break-all;">${escape(message.code)}</p></div>` : '';
  const note = message.note ? `<table role="presentation" class="note" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0;background-color:#f5f7fa;border-left:3px solid #2366d1;"><tr><td class="muted" style="padding:16px 18px;color:#56677b;font-size:13px;line-height:21px;">${copy(message.note)}</td></tr></table>` : '';
  const fallback = message.action ? `<p class="muted" style="margin:22px 0 5px;color:#56677b;font-size:12px;line-height:19px;">Button not working? Copy the complete link into your browser:</p><p style="margin:0;font-size:12px;line-height:19px;word-break:break-all;"><a class="fallback" href="${escape(message.action.url)}" style="color:#2366d1;text-decoration:underline;word-break:break-all;">${escape(message.action.url)}</a></p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(message.title)}</title>
<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse}img{border:0;outline:none}a:focus-visible{outline:3px solid #9bc8ff;outline-offset:4px}@media screen and (max-width:480px){.outer{padding:20px 10px!important}.hero{padding:26px 24px!important}.content{padding:28px 24px!important}.title{font-size:29px!important}.footer{padding:22px 24px!important}.action{width:100%!important}.action a{display:block!important;text-align:center!important}.detail-cell{font-size:12px!important}}@media(prefers-color-scheme:dark){.canvas{background-color:#0b1523!important}.card{background-color:#14243a!important;border-color:#557a9e!important}.copy,.title{color:#e5edf6!important}.muted{color:#b4c4d6!important}.note,.code{background-color:#0b1523!important}.details,.detail-cell,.footer,.code{border-color:#557a9e!important}.fallback{color:#9bc8ff!important}.status-info{background-color:#173249!important;color:#d6edf9!important}.status-warning{background-color:#382b16!important;color:#ffdf91!important}.status-success{background-color:#1d392a!important;color:#a5e2b7!important}}@media(forced-colors:active){.card,.code,.note{border:1px solid CanvasText!important}a{color:LinkText!important}}</style></head>
<body class="canvas" style="margin:0;padding:0;background-color:#edf2f7;font-family:${font};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(message.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" class="outer" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="max-width:600px;table-layout:fixed;background-color:#ffffff;border:1px solid #dae1e9;border-radius:12px;overflow:hidden;">
<tr><td class="hero" bgcolor="#10263e" style="padding:28px 36px;background-color:#10263e;border-bottom:4px solid #2366d1;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${message.brandCid?`<td width="46" style="vertical-align:middle;"><img src="cid:${message.brandCid}" width="34" height="34" alt="" style="display:block;"></td>`:''}<td style="color:#ffffff;font-size:22px;letter-spacing:3px;font-weight:bold;vertical-align:middle;">ONESA</td></tr></table>
<p style="margin:12px 0 0;color:#b4c4d6;font-size:13px;line-height:20px;">${escape(message.product)}</p></td></tr>
<tr><td class="content" style="padding:34px 36px 32px;overflow-wrap:anywhere;word-break:break-word;">
<p class="muted" style="margin:0 0 14px;color:#56677b;font-size:11px;line-height:18px;letter-spacing:1.8px;text-transform:uppercase;font-weight:bold;">${escape(message.category)}</p>
<h1 class="title" style="margin:0 0 20px;color:#10263e;font-family:${font};font-size:34px;line-height:1.16;letter-spacing:-0.7px;font-weight:bold;">${escape(message.title)}</h1>
${status?`<p style="margin:0 0 22px;">${status}</p>`:''}
${message.paragraphs.map(p=>`<p class="copy" style="margin:0 0 16px;color:#10263e;font-size:16px;line-height:27px;">${copy(p)}</p>`).join('')}${code}${action}${details}${note}${fallback}
</td></tr>
<tr><td class="footer" style="padding:22px 36px 26px;border-top:1px solid #dae1e9;">${message.footer.map((line,index)=>`<p class="muted" style="margin:0 0 5px;color:#56677b;font-size:11px;line-height:18px;${index===0?'font-weight:bold;':''}">${copy(line)}</p>`).join('')}</td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
<p class="muted" style="margin:20px 0 0;color:#56677b;font-family:${font};font-size:11px;line-height:18px;">ONESA &nbsp;/&nbsp; ${escape(message.product)}</p>
</td></tr></table></body></html>`;
}
