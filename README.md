# STAVEN BLUE V1

Railway-only STAVEN BLUE V1 with a protected Control Center, encrypted session storage, health monitoring, and controlled restart behavior.

## Railway setup

Set these Railway Variables:

- `DASHBOARD_USER=admin`
- `DASHBOARD_PASSWORD=staven10`
- `SESSION_ENCRYPTION_KEY=<long random secret>` (recommended)
- Railway supplies `PORT` automatically.

The application refuses to start outside Railway.

After deployment, Railway's generated service domain can open the dashboard. The application itself cannot control Railway's UI or automatically open a browser tab.

## Dashboard

The root route is the protected Control Center. You still need to authenticate; the password is never embedded into dashboard JavaScript.

## Session protection

AppState/cookie data is encrypted at rest with AES-256-GCM. Sensitive values are redacted from logs and are not returned by the dashboard. Existing plaintext session files are migrated to the encrypted format on successful read.

The existing cookie/session refresh system is intentionally preserved.

## Command response delay

Commands use a 3-second response delay. This is a user-experience delay and is not intended to bypass Facebook security or anti-abuse systems.

## Uptime

Railway is configured to restart the process only after a failure (`ON_FAILURE`). Graceful SIGTERM/SIGINT handling remains enabled. A platform-forced restart, deployment, crash, or resource limit cannot be prevented by application code.

Never commit cookies, AppState, passwords, tokens, `.env`, or session files.


## Group protection commands

Admin/Owner group commands:

- `!ستافين اسم <اسم المجموعة> <المدة>`
  Example: `!ستافين اسم ماغنوس اقوى 15ث`
  The bot applies the title immediately and continues checking it at the configured interval. Detected title-change events schedule a restoration after the same interval.

- `!ستافين كنيات <الكنية> <المدة>`
  Example: `!ستافين كنيات ماغنوس اقوى 10ث`
  The bot processes group members sequentially, waiting the configured interval between nickname operations, and keeps the configured nickname protection active.

- `!ستافين ايقاف`
  Stops the group title/nickname protection for the current group. Existing STAVEN auto-reply is left unchanged when group protection is the active feature.

Group protection settings are persisted in `data/group-protections.json` and are restored after a normal bot restart.
