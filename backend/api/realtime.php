<?php
/**
 * ChainMind Team Portal — Realtime endpoint (pure PHP, no Node/WebSockets)
 * -----------------------------------------------------------------
 * Does the same three jobs the old realtime-server/server.js (Node +
 * Socket.IO) used to do, over plain HTTP requests any cPanel/shared-hosting
 * PHP install can serve — no persistent process, no WebSocket proxy:
 *   1. Presence   — who's currently in the virtual space
 *   2. Movement   — broadcasting avatar x/y/z/rotation as people walk around
 *   3. Signaling  — relaying WebRTC offer/answer/ICE for calls (media never
 *                    touches this server, only small JSON messages)
 *
 * HOW THIS SIMULATES "REALTIME" WITHOUT A SOCKET:
 * The client calls action=poll, which does ONE quick check of
 * `realtime_events` and returns immediately (never blocks/sleeps inside the
 * request — see poll_events() below for why). The client re-calls right
 * away when something came back and after a short pause when nothing did,
 * so from the browser's side it still reads as a near-instant stream, even
 * though every single call is an ordinary sub-second PHP request that
 * starts, does its work, and exits — nothing ever holds a process open.
 *
 * Presence works the same way a socket server's disconnect event does, just
 * lazily: every join/move/poll call refreshes `last_seen` (polling itself
 * IS the heartbeat, no separate ping needed). Any presence row that goes
 * quiet for PRESENCE_STALE_SEC (tab closed, phone died, wifi dropped) gets
 * reaped by whichever other client's request notices it first, which pushes
 * the same space:user_left / call:peer_left events a real socket close
 * would have triggered.
 *
 * COST: roughly one small indexed query every ~0.5-1s per open tab while
 * someone is in the space — trivial for a small/medium team on ordinary
 * shared hosting, and crucially each of those queries is inside a request
 * that finishes in milliseconds rather than one that sits open for up to
 * 25 seconds. If this ever needs to scale to hundreds of concurrent people
 * in the space at once, `realtime_events` is already shaped like the
 * pub/sub log you'd want for a proper realtime service later — nothing
 * here is throwaway.
 */
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$me = (int)$auth['sub'];
$myName = $auth['name'] ?? 'Teammate';
$action = $_GET['action'] ?? '';

define('PRESENCE_STALE_SEC', 20); // no heartbeat this long => treat as disconnected (generous on purpose — see touch_presence()/reap_stale_presence() below for why a tight value here was causing false "disappearances")

switch ($action) {
    case 'join':       space_join(); break;
    case 'roster':     space_roster(); break;
    case 'move':        space_move(); break;
    case 'leave':        space_leave(); break;
    case 'poll':          poll_events(); break;
    case 'call_join':     call_join(); break;
    case 'call_leave':    call_leave(); break;
    case 'signal':         send_signal(); break;
    case 'chat':            space_chat(); break;
    default: respond(['error' => 'Unknown action'], 404);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function push_event(string $scope, string $type, int $fromUserId, ?int $toUserId, array $payload): int {
    $stmt = db()->prepare(
        'INSERT INTO realtime_events (scope, event_type, from_user_id, to_user_id, payload) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([$scope, $type, $fromUserId, $toUserId, json_encode($payload)]);
    return (int)db()->lastInsertId();
}

/**
 * The heartbeat every poll/roster/move call sends. This used to be a plain
 * UPDATE — which silently affects 0 rows and does nothing once the presence
 * row is gone. If that row ever got deleted by reap_stale_presence() (one
 * slow response, one brief network blip — anything that let a single gap
 * exceed PRESENCE_STALE_SEC), the browser would keep polling forever
 * thinking everything was fine, while staying permanently invisible to
 * every other client until a full page reload re-ran space_join(). That's
 * the "goes from 2 to 1 and stays that way" bug. Now it self-heals: if the
 * row is missing, re-create it (at the last saved position, so there's no
 * visible teleport-to-origin) and tell everyone else this person is back.
 */
function touch_presence(int $userId): void {
    global $myName;
    $stmt = db()->prepare('UPDATE realtime_presence SET last_seen = NOW() WHERE user_id = ?');
    $stmt->execute([$userId]);
    if ($stmt->rowCount() > 0) return;

    $pos = default_spawn_position($userId);
    $avatarStmt = db()->prepare('SELECT pos_x, pos_y, pos_z, rot_y FROM avatars WHERE user_id = ?');
    $avatarStmt->execute([$userId]);
    if ($saved = $avatarStmt->fetch()) {
        $pos = ['x' => (float)$saved['pos_x'], 'y' => (float)$saved['pos_y'], 'z' => (float)$saved['pos_z'], 'rotY' => (float)$saved['rot_y']];
    }
    db()->prepare(
        'INSERT INTO realtime_presence (user_id, pos_x, pos_y, pos_z, rot_y, last_seen)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE last_seen = NOW()'
    )->execute([$userId, $pos['x'], $pos['y'], $pos['z'], $pos['rotY']]);
    push_event('space', 'space:user_joined', $userId, null, ['userId' => $userId, 'name' => $myName ?? 'Teammate', 'pos' => $pos]);
}

/**
 * Finds tabs that stopped heartbeating, announces their departure, removes
 * them. Runs probabilistically from the (now very frequent) short-poll
 * calls rather than on every single one — a departure being noticed a
 * fraction of a second later is invisible to users, but running this
 * SELECT+DELETE on every poll from every open tab adds needless DB load on
 * a resource-constrained host for no real benefit.
 */
function reap_stale_presence(bool $force = false): void {
    if (!$force && mt_rand(1, 3) !== 1) return;

    $stmt = db()->prepare(
        'SELECT user_id, call_room FROM realtime_presence WHERE last_seen < (NOW() - INTERVAL ' . PRESENCE_STALE_SEC . ' SECOND)'
    );
    $stmt->execute();
    foreach ($stmt->fetchAll() as $row) {
        $uid = (int)$row['user_id'];
        if ($row['call_room']) {
            push_event('call:' . $row['call_room'], 'call:peer_left', $uid, null, ['userId' => $uid]);
        }
        push_event('space', 'space:user_left', $uid, null, ['userId' => $uid]);
        db()->prepare('DELETE FROM realtime_presence WHERE user_id = ?')->execute([$uid]);
    }

    // Occasionally prune old events so the log doesn't grow forever — no
    // cron job required, and rare enough not to add real overhead.
    if (mt_rand(1, 40) === 1) {
        db()->exec('DELETE FROM realtime_events WHERE created_at < (NOW() - INTERVAL 10 MINUTE)');
    }
}

function current_max_event_id(): int {
    $row = db()->query('SELECT MAX(id) m FROM realtime_events')->fetch();
    return (int)($row['m'] ?? 0);
}

function clean_room_id(string $raw): string {
    return substr(preg_replace('/[^a-zA-Z0-9_\-]/', '', $raw), 0, 64);
}

/**
 * Give each newly connected teammate a visible starting spot instead of
 * stacking every avatar at the world origin. The position is deterministic
 * from the user id, so every browser agrees about where that teammate starts.
 */
function default_spawn_position(int $userId): array {
    $slots = [
        ['x' => -3.2, 'y' => 0, 'z' => 0,    'rotY' => 0],
        ['x' => 3.2,  'y' => 0, 'z' => 0,    'rotY' => 0],
        ['x' => 0,    'y' => 0, 'z' => -3.2, 'rotY' => 0],
        ['x' => 0,    'y' => 0, 'z' => 3.2,  'rotY' => 0],
        ['x' => -2.4, 'y' => 0, 'z' => -2.4, 'rotY' => 0],
        ['x' => 2.4,  'y' => 0, 'z' => 2.4,  'rotY' => 0],
        ['x' => 2.4,  'y' => 0, 'z' => -2.4, 'rotY' => 0],
        ['x' => -2.4, 'y' => 0, 'z' => 2.4, 'rotY' => 0],
    ];
    return $slots[$userId % count($slots)];
}

function get_space_roster(int $excludeUserId): array {
    $stmt = db()->prepare(
        'SELECT p.user_id, u.name, p.pos_x, p.pos_y, p.pos_z, p.rot_y
         FROM realtime_presence p JOIN users u ON u.id = p.user_id
         WHERE p.user_id != ? AND u.status = "active"
         ORDER BY p.user_id ASC'
    );
    $stmt->execute([$excludeUserId]);
    return array_map(fn($r) => [
        'userId' => (int)$r['user_id'],
        'name' => $r['name'],
        'pos' => [
            'x' => (float)$r['pos_x'],
            'y' => (float)$r['pos_y'],
            'z' => (float)$r['pos_z'],
            'rotY' => (float)$r['rot_y'],
        ],
    ], $stmt->fetchAll());
}

// ---------------------------------------------------------------
// Actions
// ---------------------------------------------------------------

function space_join(): void {
    global $me, $myName;
    $body = json_body();
    $pos = [
        'x' => (float)($body['x'] ?? 0), 'y' => (float)($body['y'] ?? 0),
        'z' => (float)($body['z'] ?? 0), 'rotY' => (float)($body['rot_y'] ?? $body['rotY'] ?? 0),
    ];
    if (abs($pos['x']) < 0.001 && abs($pos['z']) < 0.001) {
        $pos = default_spawn_position($me);
    }
    reap_stale_presence(true); // force: a fresh join should never show ghosts in its own roster

    db()->prepare(
        'INSERT INTO realtime_presence (user_id, pos_x, pos_y, pos_z, rot_y, last_seen)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE pos_x = VALUES(pos_x), pos_y = VALUES(pos_y),
             pos_z = VALUES(pos_z), rot_y = VALUES(rot_y), call_room = NULL, last_seen = NOW()'
    )->execute([$me, $pos['x'], $pos['y'], $pos['z'], $pos['rotY']]);

    push_event('space', 'space:user_joined', $me, null, ['userId' => $me, 'name' => $myName, 'pos' => $pos]);

    respond([
        'self' => ['userId' => $me, 'name' => $myName, 'pos' => $pos],
        'roster' => get_space_roster($me),
        'since' => current_max_event_id(),
    ]);
}

function space_roster(): void {
    global $me;
    reap_stale_presence();
    touch_presence($me);
    respond(['roster' => get_space_roster($me)]);
}

function space_move(): void {
    global $me;
    $body = json_body();
    $x = (float)($body['x'] ?? 0); $y = (float)($body['y'] ?? 0); $z = (float)($body['z'] ?? 0);
    $rotY = (float)($body['rot_y'] ?? $body['rotY'] ?? 0);

    db()->prepare('UPDATE realtime_presence SET pos_x=?, pos_y=?, pos_z=?, rot_y=?, last_seen=NOW() WHERE user_id=?')
        ->execute([$x, $y, $z, $rotY, $me]);

    push_event('space', 'space:user_moved', $me, null, ['userId' => $me, 'pos' => ['x' => $x, 'y' => $y, 'z' => $z, 'rotY' => $rotY]]);
    respond(['ok' => true]);
}

function space_leave(): void {
    global $me;
    $stmt = db()->prepare('SELECT call_room FROM realtime_presence WHERE user_id = ?');
    $stmt->execute([$me]);
    $callRoom = $stmt->fetchColumn();
    if ($callRoom) {
        push_event('call:' . $callRoom, 'call:peer_left', $me, null, ['userId' => $me]);
    }
    db()->prepare('DELETE FROM realtime_presence WHERE user_id = ?')->execute([$me]);
    push_event('space', 'space:user_left', $me, null, ['userId' => $me]);
    respond(['ok' => true]);
}

function call_join(): void {
    global $me, $myName;
    $room = clean_room_id((string)(json_body()['room'] ?? ''));
    if ($room === '') respond(['error' => 'room is required'], 422);

    touch_presence($me);
    db()->prepare('UPDATE realtime_presence SET call_room = ? WHERE user_id = ?')->execute([$room, $me]);

    $stmt = db()->prepare('SELECT user_id FROM realtime_presence WHERE call_room = ? AND user_id != ?');
    $stmt->execute([$room, $me]);
    $existingPeers = array_map(fn($r) => (int)$r['user_id'], $stmt->fetchAll());

    push_event('call:' . $room, 'call:peer_joined', $me, null, ['userId' => $me, 'name' => $myName]);
    respond(['existing_peers' => $existingPeers, 'since' => current_max_event_id()]);
}

function call_leave(): void {
    global $me;
    $room = clean_room_id((string)(json_body()['room'] ?? ''));
    if ($room === '') respond(['error' => 'room is required'], 422);

    db()->prepare('UPDATE realtime_presence SET call_room = NULL WHERE user_id = ? AND call_room = ?')->execute([$me, $room]);
    push_event('call:' . $room, 'call:peer_left', $me, null, ['userId' => $me]);
    respond(['ok' => true]);
}

function send_signal(): void {
    global $me;
    $body = json_body();
    $room = clean_room_id((string)($body['room'] ?? 'space-global'));
    $toUserId = (int)($body['to_user_id'] ?? 0);
    $signal = $body['signal'] ?? null;
    if (!$toUserId || !$signal) respond(['error' => 'to_user_id and signal are required'], 422);

    // Signaling is metadata only; media never goes through PHP. Keep an
    // unexpectedly large browser payload from consuming a shared-host process.
    $encodedSignal = json_encode($signal);
    if ($encodedSignal === false || strlen($encodedSignal) > 24000) {
        respond(['error' => 'signal payload is too large'], 413);
    }
    push_event('call:' . $room, 'call:signal', $me, $toUserId, ['signal' => $signal]);
    respond(['ok' => true]);
}

function space_chat(): void {
    global $me, $myName;
    $text = mb_substr((string)(json_body()['text'] ?? ''), 0, 1000);
    if ($text === '') respond(['error' => 'text is required'], 422);

    push_event('space', 'space:chat', $me, null, ['userId' => $me, 'name' => $myName, 'text' => $text, 'at' => round(microtime(true) * 1000)]);
    respond(['ok' => true]);
}

/**
 * The heart of the fake-realtime trick. See file header for how this loop
 * behaves from the client's perspective.
/**
 * The heart of the fake-realtime trick.
 *
 * IMPORTANT: this used to hold the PHP process open in a sleep+query loop
 * for up to POLL_MAX_SECONDS (a real long-poll) to shave latency. On
 * cPanel/CloudLinux shared hosting that's dangerous: those accounts cap how
 * many PHP processes may run *concurrently* (the "Entry Processes" / EP
 * limit in WHM, often a single digit on budget plans). Every open browser
 * tab was pinning one of those slots for up to 25 seconds solid, so as soon
 * as a couple of people were in the space at once the account hit its
 * process cap and Apache started returning a blanket 403 for the *entire
 * account* — including the custom error page itself, which is exactly the
 * double "Forbidden ... additionally, a 403 Forbidden error was encountered
 * while trying to use an ErrorDocument" message that shows up when this
 * happens.
 *
 * This is now a true short poll: check once, respond immediately either
 * way, never sleep inside the request. The client (space.js
 * PollingSocket._loop) re-calls right away when something just came back,
 * and after a short pause when nothing did — so it still feels realtime,
 * but no request ever occupies a process for more than a few milliseconds.
 */
function poll_events(): void {
    global $me;
    $since = (int)($_GET['since'] ?? 0);
    $callRoom = isset($_GET['call_room']) ? clean_room_id((string)$_GET['call_room']) : '';

    reap_stale_presence();
    touch_presence($me); // polling IS the heartbeat

    $sql = 'SELECT id, event_type, from_user_id, payload FROM realtime_events
            WHERE id > ? AND from_user_id != ? AND (scope = "space" OR to_user_id = ?';
    $params = [$since, $me, $me];
    if ($callRoom !== '') { $sql .= ' OR scope = ?'; $params[] = 'call:' . $callRoom; }
    $sql .= ') ORDER BY id ASC LIMIT 100';

    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    if ($rows) {
        $events = array_map(fn($r) => [
            'id' => (int)$r['id'],
            'type' => $r['event_type'],
            'fromUserId' => (int)$r['from_user_id'],
            'payload' => json_decode($r['payload'], true),
        ], $rows);
        respond(['events' => $events, 'since' => (int)end($rows)['id']]);
    }

    respond(['events' => [], 'since' => $since]);
}
