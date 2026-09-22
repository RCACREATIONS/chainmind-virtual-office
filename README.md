# ChainMind Team Collaboration Portal

A virtual-office style team portal for ChainMind: team & task management, a 3D
virtual space where every teammate has an avatar they move with the keyboard,
and video/voice calls (1:1 and group) where your live webcam feed is mapped
onto your avatar's head so it actually looks like you.

Theme: white/silver with "Barney purple" (`#6B21A8`) accents, matching the
ChainMind coin mark — logo is already dropped into `public/assets/logo.png`.

## Architecture

```
chainmind-portal/
├── backend/            PHP + MySQL — the whole backend, including realtime
│   ├── api/*.php        REST endpoints (JSON in/out, JWT bearer auth)
│   │   └── realtime.php  presence, avatar-movement sync, WebRTC signaling —
│   │                     via long-polling, no Node/WebSockets required
│   ├── config/config.php
│   ├── includes/        db.php, jwt.php, bootstrap.php
│   ├── schema.sql        run this for a fresh database
│   └── migrations/       run 001_portal_upgrade.sql for an existing install
├── realtime-server/    LEGACY/OPTIONAL — the original Node.js + Socket.IO
│                        version of the realtime piece. Not used by default
│                        anymore (see "Realtime" below); kept only in case
│                        you'd rather run a real WebSocket server on a host
│                        that supports long-running Node processes.
└── public/              Static frontend (plain HTML/CSS/JS + Three.js).
    ├── index.html        login / register
    ├── portal.html       app shell: dashboard, teams, tasks, admin, avatar, space
    └── js/space.js        the 3D virtual office + WebRTC logic + the
                            long-polling client that talks to realtime.php
```

Everything — CRUD (teams/tasks/users/clock-in) *and* realtime (presence,
avatar movement, call signaling) — runs as plain PHP on one ordinary
shared/VPS host, one MySQL database, no Node process to keep alive. See
"Realtime" below for how the presence/movement/signaling piece works
without WebSockets.

## 1. Database

```bash
mysql -u root -p < backend/schema.sql
```

This creates the `chainmind_portal` database and a seed admin account:
`admin@chainmind.local` / `ChangeMe123!` — **log in once and change this
password immediately**. The portal now includes a Change password form under
My avatar.

## 2. PHP backend

1. Create a real MySQL user/password for the app (don't use root).
2. Set environment variables (or edit `backend/config/config.php` directly)
   for `CM_DB_HOST`, `CM_DB_NAME`, `CM_DB_USER`, `CM_DB_PASS`, `CM_JWT_SECRET`
   (a long random string — `openssl rand -hex 32`), `CM_APP_URL`, and
   `CM_FRONTEND_URL` (the public URL used inside invite/reset links).
3. For the current ChainMind deployment, keep the extracted folder at
   `/chainmind_portal/`, serve `public/` at
   `https://chainmind.com.ng/chainmind_portal/public/`, and make the PHP API
   available at `https://chainmind.com.ng/chainmind_portal/backend/api/`.
   If your host uses another path, set `API_BASE` in `public/js/config.js` and
   `CM_FRONTEND_URL` in the backend config to the matching URLs.
4. Requires PHP 8.0+ with `pdo_mysql` enabled. No Composer dependencies —
   it's dependency-free on purpose so it drops straight onto your existing
   ChainMind PHP hosting.

Management controls such as inviting users and creating teams/departments are
shown only to accounts whose database role is `admin` or `manager`. If the
account was promoted after login, sign out and back in; the portal also
refreshes the role from `auth.php?action=me` on each load.

For the ChainMind management login supplied for this deployment, run
`backend/migrations/002_promote_chainmind_admin.sql` once in the portal
database. The backend also refreshes roles from the database before each
authorization check, so the promotion takes effect without waiting for a JWT
to expire.

## 3. Realtime — pure PHP, no Node, works on ordinary cPanel hosting

There's nothing extra to install or run. `backend/api/realtime.php` uses the
same PHP/MySQL you already set up in steps 1-2 — it just adds two tables
(`realtime_presence`, `realtime_events`, already in `schema.sql`) and one
endpoint. Presence, avatar-movement sync, and WebRTC call signaling all go
through it.

When someone first enters the space, the server assigns a deterministic
starting position based on their user id and includes that position in both
the initial roster and the join event. This prevents teammates who enter at
the same time from being stacked at the world origin or appearing to be
missing. On phones, the virtual space also shows a four-way movement pad;
swipe or drag across the scene to rotate the view.

For an existing database created before realtime support was added, run
`backend/migrations/003_realtime_presence.sql` once. Without those two
realtime tables, the local avatar can still render while the live teammate
roster cannot connect.

**How it simulates a realtime server without WebSockets:** the browser
calls `realtime.php?action=poll` and the script *long-polls* — it loops
server-side for up to ~25 seconds, checking the database every half-second
for anything new, and returns the instant something shows up (or returns
empty and gets called again immediately if nothing did). To the browser
that reads as an unbroken stream of near-instant updates — typically under
a second of latency — with nothing but ordinary PHP requests under the
hood. No `Upgrade` headers, no long-running process, no WebSocket proxy
config, nothing your cPanel host needs to support beyond running PHP.
Presence disconnect works the same way, just lazily: every join/move/poll
call refreshes a `last_seen` heartbeat, and any row that goes quiet for 8
seconds (tab closed, wifi dropped) gets reaped by whichever other client's
request notices it first.

This is a deliberate trade: a little bit of steady database load (one
small indexed query roughly every 0.5-3s per open tab) in exchange for zero
extra infrastructure — exactly the right trade for a small/medium team on
shared hosting. `realtime_events` is shaped like a proper pub/sub log, so
if you ever outgrow this (hundreds of people in the space at once), it's a
contained swap rather than a rewrite.

*Prefer a real WebSocket server instead?* The original Node/Socket.IO
implementation is still in `realtime-server/` and works the same way it
always did — see the comments in `realtime-server/server.js`. It needs a
host that supports long-running Node processes (most shared cPanel hosting
doesn't), which is exactly what the PHP version above avoids requiring.

## 4. Frontend

Everything in `public/` is static — upload it as-is to any web host (a
subfolder of your existing PHP hosting is fine). The current config points to
the ChainMind `/chainmind_portal/` deployment path. If you deploy elsewhere,
edit **`public/js/config.js`**:

```js
window.CM_CONFIG = {
  API_BASE: 'https://your-domain.com/your-folder/backend/api',
  ...
};
```

## What was upgraded in this build

- Registration/login (first account created becomes admin automatically),
  JWT sessions, role-based access (admin/manager/member)
- Team creation with visible errors, department assignment, and membership management
- People & roles: create invited users, job titles, department assignment, expiring
  invite links, self-service password setup, password reset links, and password changes
- Departments, company announcements, leave requests, shared resource links,
  calendar events, and an admin audit log
- Task board (Kanban: To do / In progress / Review / Done) with
  priority, due dates, and multi-assignee support, drag-and-drop status changes
- Clock in/out with history
- Personal avatar customization (color, shape, display name)
- A more human-like 3D virtual office (Three.js) — head, hair, torso, arms,
  legs, shoes, WASD/arrow-key movement, mouse-drag look-around, and live presence
- Live webcam video, center-cropped and mapped onto your avatar's head in
  real time, mirrored like a normal camera
- 1:1 and group WebRTC calls (mesh topology) with mic/camera toggle, signaled
  over the pure-PHP realtime endpoint (`backend/api/realtime.php`)
- Low-bandwidth media defaults (640×360 video at 15fps, mono echo-cancelled
  audio), batched ICE signaling, and reduced presence polling for shared-host
  stability
- Solid office, desk, glass-wall, and building boundaries, vertical camera
  tilt, and a closer interior camera when an avatar enters an office
- Backend, frontend, and cloud development offices grouped inside the
  TECHNOLOGY building while remaining separate offices

## Important deployment notes

Being direct about this rather than overselling it:

1. **Use HTTPS.** Browser camera and microphone permissions only work on HTTPS
   or localhost. If the browser says site permission is blocked, open the
   portal over HTTPS, click the lock icon, set Camera and Microphone to Allow,
   reload, then enable the devices separately. The UI now shows the exact
   reason instead of silently failing.
2. **Add a TURN server.** WebRTC alone (STUN only, which is all that's
   configured by default) fails to connect a meaningful fraction of
   real-world calls — anyone behind a strict corporate firewall or certain
   mobile carrier NATs simply won't connect peer-to-peer. Run
   [coturn](https://github.com/coturn/coturn) (a few dollars/month on a small
   VPS) and add its credentials to `ICE_SERVERS` in `public/js/space.js` and
   mirror the comment in `realtime-server/server.js`.
3. **Group calls beyond ~6-8 people will strain a mesh topology** (every
   participant uploads their video N-1 times). Fine for small team huddles;
   for larger all-hands calls, swap in an SFU (LiveKit or mediasoup are the
   standard open-source options) — the signaling server already isolates
   this concern so it's a contained swap.
4. **Rate limiting & input hardening on the PHP API** — the endpoints here
   use prepared statements throughout (no SQL injection surface) and JWT
   auth, but there's no rate limiting on login/register yet. Put this behind
   Cloudflare or add basic throttling before opening registration publicly.
5. **Automated backups** of the MySQL database, as with any production app.

## Extending it

- Task comments/attachments, notifications, and a calendar view are natural
  next additions to `backend/api/tasks.php` + a new frontend panel.
- Screen sharing is a small addition to `space.js` —
  `navigator.mediaDevices.getDisplayMedia()` feeding the same peer
  connections, rendered on a floating screen mesh instead of the head sprite.
- Proximity-based auto-calling (walk near a teammate, call starts
  automatically like Gather.town) is a straightforward addition on top of the
  existing `space:move` broadcasts — check distance between avatars each
  frame and auto-trigger `call:join` with a room ID derived from both user IDs.
