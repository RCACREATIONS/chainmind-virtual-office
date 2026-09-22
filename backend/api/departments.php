<?php
require_once __DIR__ . '/../includes/bootstrap.php';
$auth = require_auth();
$action = $_GET['action'] ?? 'list';

switch ($action) {
    case 'list': list_departments(); break;
    case 'create': create_department($auth); break;
    case 'update': update_department($auth); break;
    case 'delete': delete_department($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function list_departments(): void {
    $rows = db()->query(
        'SELECT d.*, u.name AS created_by_name,
                COUNT(DISTINCT ud.user_id) AS member_count,
                COUNT(DISTINCT t.id) AS team_count
         FROM departments d
         JOIN users u ON u.id = d.created_by
         LEFT JOIN user_departments ud ON ud.department_id = d.id
         LEFT JOIN teams t ON t.department_id = d.id
         GROUP BY d.id ORDER BY d.name'
    )->fetchAll();
    respond(['departments' => $rows]);
}

function create_department(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $body = json_body();
    $name = trim($body['name'] ?? '');
    if (!$name) respond(['error' => 'Department name is required'], 422);
    $stmt = db()->prepare('INSERT INTO departments (name, description, color, created_by) VALUES (?, ?, ?, ?)');
    $stmt->execute([$name, trim($body['description'] ?? ''), $body['color'] ?? '#6B21A8', $auth['sub']]);
    $id = (int)db()->lastInsertId();
    audit_log((int)$auth['sub'], 'created_department', 'department', $id, ['name' => $name]);
    respond(['id' => $id], 201);
}

function update_department(array $auth): void {
    require_role($auth, ['admin', 'manager']);
    $body = json_body();
    $id = (int)($body['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);
    db()->prepare('UPDATE departments SET name = ?, description = ?, color = ? WHERE id = ?')
        ->execute([trim($body['name'] ?? ''), trim($body['description'] ?? ''), $body['color'] ?? '#6B21A8', $id]);
    audit_log((int)$auth['sub'], 'updated_department', 'department', $id);
    respond(['ok' => true]);
}

function delete_department(array $auth): void {
    require_role($auth, ['admin']);
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);
    db()->prepare('DELETE FROM departments WHERE id = ?')->execute([$id]);
    audit_log((int)$auth['sub'], 'deleted_department', 'department', $id);
    respond(['ok' => true]);
}