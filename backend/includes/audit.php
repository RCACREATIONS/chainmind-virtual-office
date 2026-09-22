<?php
function audit_log(?int $actorId, string $action, string $entityType, ?int $entityId = null, array $details = []): void {
    $stmt = db()->prepare(
        'INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $actorId,
        $action,
        $entityType,
        $entityId,
        $details ? json_encode($details, JSON_UNESCAPED_UNICODE) : null,
    ]);
}