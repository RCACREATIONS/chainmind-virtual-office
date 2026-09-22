<?php
require_once __DIR__ . '/../includes/bootstrap.php';

$auth = require_auth();
$action = $_GET['action'] ?? 'list';

switch ($action) {
    case 'list':   list_tasks($auth); break;
    case 'create': create_task($auth); break;
    case 'update': update_task($auth); break;
    case 'delete': delete_task($auth); break;
    default: respond(['error' => 'Unknown action'], 404);
}

function list_tasks(array $auth): void {
    $pdo = db();
    $where = [];
    $params = [];
    if (!empty($_GET['team_id'])) { $where[] = 't.team_id = ?'; $params[] = (int)$_GET['team_id']; }
    if (!empty($_GET['status']))  { $where[] = 't.status = ?';  $params[] = $_GET['status']; }
    // Non-admins only see tasks on teams they belong to, or tasks assigned to them
    if (!in_array($auth['role'], ['admin', 'manager'], true)) {
        $where[] = '(t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id = ?))';
        $params[] = $auth['sub'];
        $params[] = $auth['sub'];
    }
    $sql = 'SELECT t.*, tm.name AS team_name FROM tasks t LEFT JOIN teams tm ON tm.id = t.team_id';
    if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
    $sql .= ' ORDER BY FIELD(t.priority,"urgent","high","medium","low"), t.due_date IS NULL, t.due_date ASC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $tasks = $stmt->fetchAll();

    foreach ($tasks as &$task) {
        $stmt = $pdo->prepare('SELECT u.id, u.name, a.body_color FROM task_assignees ta
                                JOIN users u ON u.id = ta.user_id LEFT JOIN avatars a ON a.user_id = u.id
                                WHERE ta.task_id = ?');
        $stmt->execute([$task['id']]);
        $task['assignees'] = $stmt->fetchAll();
    }
    respond(['tasks' => $tasks]);
}

function create_task(array $auth): void {
    $body = json_body();
    $title = trim($body['title'] ?? '');
    if (!$title) respond(['error' => 'Title is required'], 422);

    $pdo = db();
    $stmt = $pdo->prepare('INSERT INTO tasks (team_id, title, description, priority, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $body['team_id'] ?? null,
        $title,
        $body['description'] ?? '',
        in_array($body['priority'] ?? 'medium', ['low','medium','high','urgent'], true) ? $body['priority'] : 'medium',
        $body['due_date'] ?? null,
        $auth['sub'],
    ]);
    $taskId = (int)$pdo->lastInsertId();

    foreach ($body['assignee_ids'] ?? [] as $uid) {
        $pdo->prepare('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)')->execute([$taskId, (int)$uid]);
    }
    respond(['id' => $taskId], 201);
}

function update_task(array $auth): void {
    $body = json_body();
    $id = (int)($body['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);

    $fields = [];
    $params = [];
    foreach (['title', 'description', 'status', 'priority', 'due_date', 'team_id'] as $f) {
        if (array_key_exists($f, $body)) { $fields[] = "$f = ?"; $params[] = $body[$f]; }
    }
    if ($fields) {
        $params[] = $id;
        db()->prepare('UPDATE tasks SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($params);
    }

    if (isset($body['assignee_ids'])) {
        $pdo = db();
        $pdo->prepare('DELETE FROM task_assignees WHERE task_id = ?')->execute([$id]);
        foreach ($body['assignee_ids'] as $uid) {
            $pdo->prepare('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)')->execute([$id, (int)$uid]);
        }
    }
    respond(['ok' => true]);
}

function delete_task(array $auth): void {
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) respond(['error' => 'id is required'], 422);
    db()->prepare('DELETE FROM tasks WHERE id = ?')->execute([$id]);
    respond(['ok' => true]);
}
