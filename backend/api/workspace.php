<?php
require_once __DIR__ . '/../includes/bootstrap.php';
$auth = require_auth();
$action = $_GET['action'] ?? 'summary';

switch ($action) {
    case 'summary': workspace_summary($auth); break;
    case 'announcements': announcements($auth); break;
    case 'create_announcement': create_announcement($auth); break;
    case 'leave': leave_request($auth); break;
    case 'leave_list': leave_list($auth); break;
    case 'leave_status': leave_status($auth); break;
    case 'events': events(); break;
    case 'create_event': create_event($auth); break;
    case 'resources': resources(); break;
    case 'create_resource': create_resource($auth); break;
    case 'audit': audit_list($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function workspace_summary(array $auth): void {
    $pdo = db();
    $summary = [
        'users' => (int)$pdo->query('SELECT COUNT(*) FROM users WHERE status = "active"')->fetchColumn(),
        'teams' => (int)$pdo->query('SELECT COUNT(*) FROM teams')->fetchColumn(),
        'departments' => (int)$pdo->query('SELECT COUNT(*) FROM departments')->fetchColumn(),
        'pending_leave' => (int)$pdo->query('SELECT COUNT(*) FROM leave_requests WHERE status = "pending"')->fetchColumn(),
    ];
    respond(['summary' => $summary]);
}

function announcements(array $auth): void {
    $rows = db()->query(
        'SELECT a.*, u.name AS author, d.name AS department_name, t.name AS team_name
         FROM announcements a JOIN users u ON u.id = a.created_by
         LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN teams t ON t.id = a.team_id
         ORDER BY a.created_at DESC LIMIT 20'
    )->fetchAll();
    respond(['announcements' => $rows]);
}

function create_announcement(array $auth): void {
    require_role($auth, ['admin', 'manager', 'department_lead']);
    $body = json_body();
    $title = trim($body['title'] ?? '');
    $text = trim($body['body'] ?? '');
    if (!$title || !$text) respond(['error' => 'Title and message are required'], 422);
    $stmt = db()->prepare('INSERT INTO announcements (title, body, audience, department_id, team_id, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([$title, $text, $body['audience'] ?? 'company', $body['department_id'] ?: null, $body['team_id'] ?: null, $auth['sub']]);
    $id = (int)db()->lastInsertId();
    audit_log((int)$auth['sub'], 'created_announcement', 'announcement', $id);
    respond(['id' => $id], 201);
}

function leave_request(array $auth): void {
    $body = json_body();
    if (empty($body['start_date']) || empty($body['end_date'])) respond(['error' => 'Start and end dates are required'], 422);
    $stmt = db()->prepare('INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$auth['sub'], $body['leave_type'] ?? 'Annual leave', $body['start_date'], $body['end_date'], trim($body['reason'] ?? '')]);
    respond(['id' => (int)db()->lastInsertId()], 201);
}

function leave_list(array $auth): void {
    $sql = 'SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id';
    $params = [];
    if (!in_array($auth['role'] ?? '', ['admin', 'manager'], true)) { $sql .= ' WHERE l.user_id = ?'; $params[] = $auth['sub']; }
    $sql .= ' ORDER BY l.created_at DESC LIMIT 100';
    $stmt = db()->prepare($sql); $stmt->execute($params);
    respond(['leave' => $stmt->fetchAll()]);
}

function leave_status(array $auth): void {
    require_role($auth, ['admin', 'manager', 'department_lead']);
    $body = json_body();
    $status = in_array($body['status'] ?? '', ['approved', 'rejected', 'pending'], true) ? $body['status'] : 'pending';
    db()->prepare('UPDATE leave_requests SET status = ?, approved_by = ? WHERE id = ?')->execute([$status, $auth['sub'], (int)$body['id']]);
    respond(['ok' => true]);
}

function events(): void {
    $rows = db()->query('SELECT e.*, u.name AS author, t.name AS team_name FROM calendar_events e JOIN users u ON u.id = e.created_by LEFT JOIN teams t ON t.id = e.team_id ORDER BY e.start_at LIMIT 100')->fetchAll();
    respond(['events' => $rows]);
}

function create_event(array $auth): void {
    require_role($auth, ['admin', 'manager', 'department_lead']);
    $body = json_body();
    if (!trim($body['title'] ?? '') || empty($body['start_at'])) respond(['error' => 'Title and start time are required'], 422);
    $stmt = db()->prepare('INSERT INTO calendar_events (title, description, start_at, end_at, location, team_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([trim($body['title']), trim($body['description'] ?? ''), $body['start_at'], $body['end_at'] ?: null, trim($body['location'] ?? ''), $body['team_id'] ?: null, $auth['sub']]);
    respond(['id' => (int)db()->lastInsertId()], 201);
}

function resources(): void {
    $rows = db()->query('SELECT r.*, u.name AS author FROM shared_resources r JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 100')->fetchAll();
    respond(['resources' => $rows]);
}

function create_resource(array $auth): void {
    require_role($auth, ['admin', 'manager', 'department_lead']);
    $body = json_body();
    if (!trim($body['name'] ?? '') || !filter_var($body['url'] ?? '', FILTER_VALIDATE_URL)) respond(['error' => 'Name and a valid URL are required'], 422);
    $stmt = db()->prepare('INSERT INTO shared_resources (name, url, description, created_by) VALUES (?, ?, ?, ?)');
    $stmt->execute([trim($body['name']), $body['url'], trim($body['description'] ?? ''), $auth['sub']]);
    respond(['id' => (int)db()->lastInsertId()], 201);
}

function audit_list(array $auth): void {
    require_role($auth, ['admin']);
    $rows = db()->query('SELECT a.*, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.created_at DESC LIMIT 100')->fetchAll();
    respond(['audit' => $rows]);
}