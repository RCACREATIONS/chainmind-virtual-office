<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$action = $_GET['action'] ?? 'status';

switch ($action) {
    case 'in':      clock_in($auth); break;
    case 'out':     clock_out($auth); break;
    case 'status':  status($auth); break;
    case 'history': history($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function open_session(int $userId) {
    $stmt = db()->prepare('SELECT * FROM clock_logs WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1');
    $stmt->execute([$userId]);
    return $stmt->fetch();
}

function clock_in(array $auth): void {
    if (open_session((int)$auth['sub'])) respond(['error' => 'Already clocked in'], 409);
    db()->prepare('INSERT INTO clock_logs (user_id, clock_in) VALUES (?, NOW())')->execute([$auth['sub']]);
    respond(['ok' => true]);
}

function clock_out(array $auth): void {
    $session = open_session((int)$auth['sub']);
    if (!$session) respond(['error' => 'Not currently clocked in'], 409);
    db()->prepare('UPDATE clock_logs SET clock_out = NOW() WHERE id = ?')->execute([$session['id']]);
    respond(['ok' => true]);
}

function status(array $auth): void {
    $session = open_session((int)$auth['sub']);
    respond(['clocked_in' => (bool)$session, 'since' => $session['clock_in'] ?? null]);
}

function history(array $auth): void {
    $userId = (int)($_GET['user_id'] ?? $auth['sub']);
    if ($userId !== (int)$auth['sub']) require_role($auth, ['admin', 'manager']);
    $stmt = db()->prepare('SELECT * FROM clock_logs WHERE user_id = ? ORDER BY clock_in DESC LIMIT 60');
    $stmt->execute([$userId]);
    respond(['history' => $stmt->fetchAll()]);
}
