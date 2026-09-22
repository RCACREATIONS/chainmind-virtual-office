<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'register': handle_register(); break;
    case 'login': handle_login(); break;
    case 'me': handle_me(); break;
    case 'accept_invite': handle_accept_invite(); break;
    case 'request_reset': handle_request_reset(); break;
    case 'reset_password': handle_reset_password(); break;
    case 'change_password': handle_change_password(); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function issue_token(array $user): string {
    return jwt_encode([
        'sub' => $user['id'],
        'name' => $user['name'],
        'email' => $user['email'],
        'role' => $user['role'],
    ]);
}

function public_user(array $user): array {
    return [
        'id' => (int)$user['id'],
        'name' => $user['name'],
        'email' => $user['email'],
        'role' => $user['role'],
        'title' => $user['title'] ?? null,
    ];
}

function handle_register(): void {
    $body = json_body();
    $name = trim($body['name'] ?? '');
    $email = strtolower(trim($body['email'] ?? ''));
    $password = $body['password'] ?? '';
    if (!$name || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 8) {
        respond(['error' => 'Name, a valid email, and an 8+ character password are required'], 422);
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $stmt->execute([$email]);
    if ($stmt->fetch()) respond(['error' => 'An account with that email already exists'], 409);

    $count = (int)$pdo->query('SELECT COUNT(*) c FROM users')->fetch()['c'];
    $role = $count === 0 ? 'admin' : 'member';
    $pdo->beginTransaction();
    $stmt = $pdo->prepare('INSERT INTO users (name, email, password_hash, role, title) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$name, $email, password_hash($password, PASSWORD_BCRYPT), $role, $body['title'] ?? null]);
    $userId = (int)$pdo->lastInsertId();
    $palette = ['#6B21A8', '#8B3FD1', '#4C1D7A', '#A78BFA', '#0E7490'];
    $stmt = $pdo->prepare('INSERT INTO avatars (user_id, display_name, body_color) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $name, $palette[array_rand($palette)]]);
    $pdo->commit();

    $user = ['id' => $userId, 'name' => $name, 'email' => $email, 'role' => $role, 'title' => $body['title'] ?? null];
    respond(['token' => issue_token($user), 'user' => public_user($user)], 201);
}

function handle_login(): void {
    $body = json_body();
    $email = strtolower(trim($body['email'] ?? ''));
    $stmt = db()->prepare('SELECT * FROM users WHERE email = ?');
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($body['password'] ?? '', $user['password_hash'])) {
        respond(['error' => 'Invalid email or password'], 401);
    }
    if ($user['status'] === 'invited') respond(['error' => 'Accept your invite link and set a password before signing in'], 403);
    if ($user['status'] !== 'active') respond(['error' => 'This account has been suspended'], 403);

    audit_log((int)$user['id'], 'login', 'user', (int)$user['id']);
    respond(['token' => issue_token($user), 'user' => public_user($user)]);
}

function handle_me(): void {
    $auth = require_auth();
    $stmt = db()->prepare(
        'SELECT u.id, u.name, u.email, u.role, u.title, u.status, a.display_name, a.body_color, a.body_shape, a.head_style,
                GROUP_CONCAT(d.name ORDER BY d.name SEPARATOR ", ") AS departments
         FROM users u
         LEFT JOIN avatars a ON a.user_id = u.id
         LEFT JOIN user_departments ud ON ud.user_id = u.id
         LEFT JOIN departments d ON d.id = ud.department_id
         WHERE u.id = ? GROUP BY u.id'
    );
    $stmt->execute([$auth['sub']]);
    $row = $stmt->fetch();
    if (!$row) respond(['error' => 'Not found'], 404);
    respond(['user' => $row]);
}

function handle_accept_invite(): void {
    $body = json_body();
    $token = (string)($body['token'] ?? '');
    $password = (string)($body['password'] ?? '');
    if (strlen($token) < 20 || strlen($password) < 8) respond(['error' => 'A valid invite and an 8+ character password are required'], 422);

    $stmt = db()->prepare(
        'SELECT i.*, u.id AS user_id, u.name AS user_name, u.email AS user_email
         FROM invitations i JOIN users u ON u.email = i.email
         WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > NOW() LIMIT 1'
    );
    $stmt->execute([hash('sha256', $token)]);
    $invite = $stmt->fetch();
    if (!$invite) respond(['error' => 'This invite link is invalid or has expired'], 410);

    $pdo = db();
    $pdo->beginTransaction();
    $pdo->prepare('UPDATE users SET name = ?, role = ?, title = ?, password_hash = ?, status = "active" WHERE id = ?')
        ->execute([$invite['name'], $invite['role'], $invite['title'], password_hash($password, PASSWORD_BCRYPT), $invite['user_id']]);
    $pdo->prepare('UPDATE invitations SET accepted_at = NOW() WHERE id = ?')->execute([$invite['id']]);
    $pdo->commit();
    $user = ['id' => $invite['user_id'], 'name' => $invite['name'], 'email' => $invite['email'], 'role' => $invite['role'], 'title' => $invite['title']];
    audit_log((int)$user['id'], 'accepted_invite', 'user', (int)$user['id']);
    respond(['token' => issue_token($user), 'user' => public_user($user)]);
}

function handle_request_reset(): void {
    $email = strtolower(trim(json_body()['email'] ?? ''));
    $stmt = db()->prepare('SELECT id FROM users WHERE email = ? AND status != "suspended"');
    $stmt->execute([$email]);
    $user = $stmt->fetch();
    if (!$user) respond(['message' => 'If that account exists, a reset link has been created.']);

    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 2 HOUR))')
        ->execute([$user['id'], hash('sha256', $token)]);
    respond(['message' => 'Reset link created.', 'reset_url' => rtrim(FRONTEND_URL, '/') . '/index.html?reset=' . urlencode($token)]);
}

function handle_reset_password(): void {
    $body = json_body();
    $token = (string)($body['token'] ?? '');
    $password = (string)($body['password'] ?? '');
    if (strlen($password) < 8) respond(['error' => 'Password must be at least 8 characters'], 422);
    $stmt = db()->prepare('SELECT pr.*, u.* FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW()');
    $stmt->execute([hash('sha256', $token)]);
    $reset = $stmt->fetch();
    if (!$reset) respond(['error' => 'This reset link is invalid or has expired'], 410);
    db()->prepare('UPDATE users SET password_hash = ?, status = "active" WHERE id = ?')->execute([password_hash($password, PASSWORD_BCRYPT), $reset['user_id']]);
    db()->prepare('UPDATE password_resets SET used_at = NOW() WHERE id = ?')->execute([$reset['id']]);
    $user = ['id' => $reset['user_id'], 'name' => $reset['name'], 'email' => $reset['email'], 'role' => $reset['role'], 'title' => $reset['title']];
    respond(['token' => issue_token($user), 'user' => public_user($user)]);
}

function handle_change_password(): void {
    $auth = require_auth();
    $body = json_body();
    if (strlen((string)($body['new_password'] ?? '')) < 8) respond(['error' => 'New password must be at least 8 characters'], 422);
    $stmt = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$auth['sub']]);
    $current = $stmt->fetchColumn();
    if (!$current || !password_verify($body['current_password'] ?? '', $current)) respond(['error' => 'Current password is incorrect'], 422);
    db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($body['new_password'], PASSWORD_BCRYPT), $auth['sub']]);
    audit_log((int)$auth['sub'], 'changed_password', 'user', (int)$auth['sub']);
    respond(['ok' => true]);
}