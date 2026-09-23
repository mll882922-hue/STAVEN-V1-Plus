import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || 'staven10',
  sessionEncryptionKey: process.env.SESSION_ENCRYPTION_KEY || process.env.DASHBOARD_PASSWORD || 'staven10',
  railwayOnly: true,
};

if (!process.env.DASHBOARD_PASSWORD) {
  console.warn('[STAVEN] DASHBOARD_PASSWORD is not set; using the requested default password.');
}
if (!process.env.SESSION_ENCRYPTION_KEY) {
  console.warn('[STAVEN] SESSION_ENCRYPTION_KEY is not set; deriving the at-rest encryption key from the dashboard password. Set a dedicated key in Railway for stronger isolation.');
}
