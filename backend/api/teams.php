<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$action = $_GET['action'] ?? 'list';

switch ($action) {
    case 'list':          list_teams($auth); break;
    case 'create':        create_team($auth); break;
    case 'update':        update_team($auth); break;
    case 'delete':        delete_team($auth); break;
    case 'add_member':    add_member($auth); break;
    case 'remove_member': remove_member($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function list_teams(array $auth): void {
    $pdo = db();
    $teams = $pdo->query('SELECT t.*, u.name AS created_by_name, d.name AS department_name
                          FROM teams t JOIN users u ON u.id = t.created_by
                          LEFT JOIN departments d ON d.id = t.department_id
                          ORDER BY t.created_at DESC')->fetchAll();
    foreach ($teams as &$team) {
        $stmt = $pdo->prepare('SELECT u.id, u.name, u.email, tm.role_in_team, a.body_color
                                FROM team_members tm JOIN users u ON u.id = tm.user_id
                                LEFT JOIN avatars a ON a.user_id = u.id WHERE tm.team_id = ?');
        $stmt->execute([$team['id']]);
        $team['members'] = $stmt->fetchAll();
    }
    respond(['teams' => $teams]);
}

function create_team(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $body = json_body();
    $name = trim($body['name'] ?? '');
    if (!$name) respond(['error' => 'Team name is required'], 422);

    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO teams (name, description, color, department_id, created_by) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$name, $body['description'] ?? '', $body['color'] ?? '#6B21A8', $body['department_id'] ?: null, $auth['sub']]);
    $teamId = (int)$pdo->lastInsertId();

    // creator is automatically the team lead
    $pdo->prepare('INSERT INTO team_members (team_id, user_id, role_in_team) VALUES (?, ?, "lead")')
        ->execute([$teamId, $auth['sub']]);

    audit_log((int)$auth['sub'], 'created_team', 'team', $teamId, ['name' => $name]);
    respond(['id' => $teamId], 201);
}

function update_team(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $body = json_body();
    $id = (int)($body['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);
    $stmt = db()->prepare('UPDATE teams SET name = ?, description = ?, color = ?, department_id = ? WHERE id = ?');
    $stmt->execute([$body['name'] ?? '', $body['description'] ?? '', $body['color'] ?? '#6B21A8', $body['department_id'] ?: null, $id]);
    respond(['ok' => true]);
}

function delete_team(array $auth): void {
    require_role($auth, ['admin']);
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);
    db()->prepare('DELETE FROM teams WHERE id = ?')->execute([$id]);
    respond(['ok' => true]);
}

function add_member(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $body = json_body();
    $teamId = (int)($body['team_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    $roleInTeam = in_array($body['role_in_team'] ?? 'member', ['lead', 'member'], true) ? $body['role_in_team'] : 'member';
    if (!$teamId || !$userId) respond(['error' => 'team_id and user_id are required'], 422);

    $stmt = db()->prepare('INSERT IGNORE INTO team_members (team_id, user_id, role_in_team) VALUES (?, ?, ?)');
    $stmt->execute([$teamId, $userId, $roleInTeam]);
    respond(['ok' => true]);
}

function remove_member(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $teamId = (int)($_GET['team_id'] ?? 0);
    $userId = (int)($_GET['user_id'] ?? 0);
    db()->prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')->execute([$teamId, $userId]);
    respond(['ok' => true]);
}
