<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$action = $_GET['action'] ?? 'list';

switch ($action) {
    case 'list': list_users($auth); break;
    case 'create': create_user($auth); break;
    case 'set_role': set_role($auth); break;
    case 'suspend': suspend($auth); break;
    case 'invite_reset': invite_reset($auth); break;
    case 'assign_departments': assign_departments($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function can_manage_users(array $auth): void {
    require_role($auth, ['admin', 'manager']);
}

function list_users(array $auth): void {
    $rows = db()->query(
        'SELECT u.id, u.name, u.email, u.role, u.title, u.status, u.created_at,
                GROUP_CONCAT(d.name ORDER BY d.name SEPARATOR ", ") AS departments
         FROM users u
         LEFT JOIN user_departments ud ON ud.user_id = u.id
         LEFT JOIN departments d ON d.id = ud.department_id
         GROUP BY u.id ORDER BY u.name'
    )->fetchAll();
    respond(['users' => $rows]);
}

function create_user(array $auth): void {
    can_manage_users($auth);
    $body = json_body();
    $name = trim($body['name'] ?? '');
    $email = strtolower(trim($body['email'] ?? ''));
    $role = $body['role'] ?? 'member';
    if (!$name || !filter_var($email, FILTER_VALIDATE_EMAIL) || !in_array($role, ['admin', 'manager', 'department_lead', 'member'], true)) {
        respond(['error' => 'Name, valid email, and a valid access role are required'], 422);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute([$email]);
    if ($stmt->fetch()) respond(['error' => 'An account with that email already exists'], 409);

    $inviteToken = bin2hex(random_bytes(32));
    $pdo->beginTransaction();
    $stmt = $pdo->prepare('INSERT INTO users (name, email, password_hash, role, title, status) VALUES (?, ?, ?, ?, ?, "invited")');
    $stmt->execute([$name, $email, password_hash(bin2hex(random_bytes(24)), PASSWORD_BCRYPT), $role, trim($body['title'] ?? '') ?: null]);
    $userId = (int)$pdo->lastInsertId();
    $pdo->prepare('INSERT INTO avatars (user_id, display_name, body_color) VALUES (?, ?, ?)')
        ->execute([$userId, $name, '#6B21A8']);
    $pdo->prepare('INSERT INTO invitations (email, name, role, title, token_hash, expires_at, invited_by) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY), ?)')
        ->execute([$email, $name, $role, trim($body['title'] ?? '') ?: null, hash('sha256', $inviteToken), $auth['sub']]);
    if (!empty($body['department_ids']) && is_array($body['department_ids'])) {
        $deptStmt = $pdo->prepare('INSERT IGNORE INTO user_departments (user_id, department_id, is_primary) VALUES (?, ?, ?)');
        foreach ($body['department_ids'] as $i => $departmentId) $deptStmt->execute([$userId, (int)$departmentId, $i === 0 ? 1 : 0]);
    }
    $pdo->commit();
    audit_log((int)$auth['sub'], 'created_invite', 'user', $userId, ['email' => $email, 'role' => $role]);
    respond([
        'id' => $userId,
        'invite_url' => rtrim(FRONTEND_URL, '/') . '/index.html?invite=' . urlencode($inviteToken),
        'expires_in_days' => 7,
    ], 201);
}

function set_role(array $auth): void {
    require_role($auth, ['admin']);
    $body = json_body();
    $id = (int)($body['user_id'] ?? 0);
    $role = $body['role'] ?? '';
    if (!$id || !in_array($role, ['admin', 'manager', 'department_lead', 'member'], true)) respond(['error' => 'Invalid input'], 422);
    db()->prepare('UPDATE users SET role = ? WHERE id = ?')->execute([$role, $id]);
    audit_log((int)$auth['sub'], 'changed_role', 'user', $id, ['role' => $role]);
    respond(['ok' => true]);
}

function suspend(array $auth): void {
    require_role($auth, ['admin']);
    $body = json_body();
    $id = (int)($body['user_id'] ?? 0);
    $status = ($body['status'] ?? '') === 'active' ? 'active' : 'suspended';
    if (!$id) respond(['error' => 'user_id is required'], 422);
    db()->prepare('UPDATE users SET status = ? WHERE id = ?')->execute([$status, $id]);
    audit_log((int)$auth['sub'], $status === 'active' ? 'reactivated_user' : 'suspended_user', 'user', $id);
    respond(['ok' => true]);
}

function invite_reset(array $auth): void {
    can_manage_users($auth);
    $id = (int)(json_body()['user_id'] ?? 0);
    $stmt = db()->prepare('SELECT * FROM users WHERE id = ?');
    $stmt->execute([$id]);
    $user = $stmt->fetch();
    if (!$user) respond(['error' => 'User not found'], 404);
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 2 HOUR))')
        ->execute([$id, hash('sha256', $token)]);
    audit_log((int)$auth['sub'], 'issued_password_reset', 'user', $id);
    respond(['reset_url' => rtrim(FRONTEND_URL, '/') . '/index.html?reset=' . urlencode($token)]);
}

function assign_departments(array $auth): void {
    can_manage_users($auth);
    $body = json_body();
    $userId = (int)($body['user_id'] ?? 0);
    $departmentIds = is_array($body['department_ids'] ?? null) ? $body['department_ids'] : [];
    if (!$userId) respond(['error' => 'user_id is required'], 422);
    $pdo = db();
    $pdo->beginTransaction();
    $pdo->prepare('DELETE FROM user_departments WHERE user_id = ?')->execute([$userId]);
    $stmt = $pdo->prepare('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES (?, ?, ?)');
    foreach ($departmentIds as $i => $departmentId) $stmt->execute([$userId, (int)$departmentId, $i === 0 ? 1 : 0]);
    $pdo->commit();
    audit_log((int)$auth['sub'], 'assigned_departments', 'user', $userId, ['department_ids' => $departmentIds]);
    respond(['ok' => true]);
}