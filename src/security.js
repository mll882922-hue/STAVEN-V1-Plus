export const protections = [
  'global-error-handler',
  'unhandled-rejection-handler',
  'helmet-security-headers',
  'rate-limiting',
  'dashboard-authentication',
  'secure-http-only-session-cookie',
  'admin-authorization',
  'input-validation',
  'input-size-limits',
  'command-response-delay',
  'duplicate-event-guard',
  'session-state-validation',
  'session-singleton-lock',
  'encrypted-appstate-at-rest',
  'safe-secret-redaction',
  'path-traversal-prevention',
  'safe-json-parsing',
  'graceful-shutdown',
  'health-monitoring'
];

export function redact(v) {
  return String(v ?? '').replace(
    /(cookie|token|password|appstate|authorization|sessionEncryptionKey|xs|c_user)\s*[:=]\s*[^,\s]+/ig,
    '$1=[REDACTED]'
  );
}
