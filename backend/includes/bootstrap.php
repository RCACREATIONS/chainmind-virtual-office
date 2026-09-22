<?php
require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/jwt.php';
require_once __DIR__ . '/audit.php';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
    header("Access-Control-Allow-Origin: $origin");
}
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function json_body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function respond($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}
