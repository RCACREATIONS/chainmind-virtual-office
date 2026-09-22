<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$action = $_GET['action'] ?? 'mine';

switch ($action) {
    case 'mine':      get_mine($auth); break;
    case 'update':     update_avatar($auth); break;
    case 'save_pos':   save_position($auth); break;
    case 'roster':     roster($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function get_mine(array $auth): void {
    $stmt = db()->prepare('SELECT * FROM avatars WHERE user_id = ?');
    $stmt->execute([$auth['sub']]);
    respond(['avatar' => $stmt->fetch()]);
}

function update_avatar(array $auth): void {
    $body = json_body();
    $fields = [];
    $params = [];
    foreach (['display_name', 'body_color', 'accent_color', 'body_shape', 'head_style'] as $f) {
        if (array_key_exists($f, $body)) { $fields[] = "$f = ?"; $params[] = $body[$f]; }
    }
    if (!$fields) respond(['error' => 'Nothing to update'], 422);
    $params[] = $auth['sub'];
    db()->prepare('UPDATE avatars SET ' . implode(', ', $fields) . ' WHERE user_id = ?')->execute($params);
    respond(['ok' => true]);
}

/**
 * Positions are also broadcast live via long-polling (see
 * backend/api/realtime.php) — this endpoint just persists a "last known
 * position" so avatars resume where they left off after a page reload.
 */
function save_position(array $auth): void {
    $body = json_body();
    $stmt = db()->prepare('UPDATE avatars SET pos_x = ?, pos_y = ?, pos_z = ?, rot_y = ? WHERE user_id = ?');
    $stmt->execute([
        (float)($body['x'] ?? 0), (float)($body['y'] ?? 0), (float)($body['z'] ?? 0),
        (float)($body['rot_y'] ?? 0), $auth['sub'],
    ]);
    respond(['ok' => true]);
}

/** Everyone's avatar + basic identity, used to render the 3D space and the presence list. */
function roster(array $auth): void {
    $rows = db()->query('SELECT u.id AS user_id, u.name, u.role, u.title, a.display_name, a.body_color, a.accent_color,
                                 a.body_shape, a.head_style, a.pos_x, a.pos_y, a.pos_z, a.rot_y
                          FROM users u JOIN avatars a ON a.user_id = u.id WHERE u.status = "active"')->fetchAll();
    respond(['roster' => $rows]);
}
