import type { Plugin } from 'vite';

/**
 * Content Security Policy for the RIFLO apps (audit 3.3, 3.7): scripts only from the app's own
 * origin, network calls only to the app and the RIFLO API, no plugins, no framing via <base>/<form> tricks.
 * The single-file preview inlines its script, so it is built without this meta tag; production hosts
 * should also send the same policy as an HTTP header, with `frame-ancestors 'none'` (see docs/LAUNCH.md).
 */
export function cspPlugin(apiUrl: string | undefined, enabled: boolean): Plugin {
  const api = apiUrl ? new URL(apiUrl).origin : '';
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https:",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  return {
    name: 'riflo-csp',
    apply: 'build',
    transformIndexHtml: (html) => (enabled ? html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`) : html)
  };
}
