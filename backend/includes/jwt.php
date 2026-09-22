<?php
/**
 * Minimal, dependency-free JWT (HS256) implementation.
 * Good enough for a single-backend deployment. If you later split services,
 * swap this for firebase/php-jwt via composer — the token shape is compatible.
 */
require_once __DIR__ . '/../config/config.php';

function base64url_encode(string $data): string {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64url_decode(string $data): string {
    $remainder = strlen($data) % 4;
    if ($remainder) $data .= str_repeat('=', 4 - $remainder);
    return base64_decode(strtr($data, '-_', '+/'));
}

function jwt_encode(array $payload): string {
    $header = base64url_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload['exp'] = time() + JWT_TTL_SECONDS;
    $payload['iat'] = time();
    $body = base64url_encode(json_encode($payload));
    $signature = base64url_encode(hash_hmac('sha256', "$header.$body", JWT_SECRET, true));
    return "$header.$body.$signature";
}

/** Internal diagnostic state; never send it back to the browser. */
$GLOBALS['CM_AUTH_DEBUG'] = 'no token found';

/** Returns the decoded payload array, or null if invalid/expired. */
function jwt_decode(string $token): ?array {
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        $GLOBALS['CM_AUTH_DEBUG'] = 'invalid token format';
        return null;
    }
    [$header, $body, $signature] = $parts;
    $expected = base64url_encode(hash_hmac('sha256', "$header.$body", JWT_SECRET, true));
    if (!hash_equals($expected, $signature)) {
        $GLOBALS['CM_AUTH_DEBUG'] = 'invalid token signature';
        return null;
    }
    $payload = json_decode(base64url_decode($body), true);
    if (!$payload) {
        $GLOBALS['CM_AUTH_DEBUG'] = 'signature valid but payload failed to json_decode';
        return null;
    }
    if (($payload['exp'] ?? 0) < time()) {
        $GLOBALS['CM_AUTH_DEBUG'] = 'token expired';
        return null;
    }
    return $payload;
}

/**
 * Reads the bearer token from the Authorization header, verifies it,
 * returns user payload or null.
 *
 * Falls back to a `?token=` query param when no Authorization header is
 * present. This is only there for navigator.sendBeacon() calls, which
 * can't set custom headers — used by realtime.php's "leave" action so a
 * closing tab clears its presence immediately instead of waiting for the
 * ~8s heartbeat timeout. Same token, same expiry, just carried in the URL
 * for that one best-effort call instead of a header.
 */
function current_user(): ?array {
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $auth = $headers['Authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if (preg_match('/Bearer\s+(\S+)/', $auth, $m)) {
        return jwt_decode($m[1]);
    }
    if (!empty($_GET['token'])) {
        return jwt_decode($_GET['token']);
    }
    $GLOBALS['CM_AUTH_DEBUG'] = 'no authorization token';
    return null;
}

/** Call at the top of any protected endpoint. Exits with 401 if not authenticated. */
function require_auth(): array {
    $user = current_user();
    if (!$user) {
        http_response_code(401);
        // Include the internal reason (invalid format / bad signature / expired /
        // no token found at all) so the client can show it instead of a bare
        // "Unauthorized" — this is a category label, not anything secret.
        echo json_encode(['error' => 'Unauthorized', 'reason' => $GLOBALS['CM_AUTH_DEBUG'] ?? null]);
        exit;
    }

    // Roles can change after a JWT was issued. Refresh the account from the
    // database so a newly promoted admin does not remain blocked by a stale
    // role claim, and a suspended account loses access immediately.
    $stmt = db()->prepare('SELECT id, name, email, role, status FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([(int)($user['sub'] ?? 0)]);
    $fresh = $stmt->fetch();
    if (!$fresh || $fresh['status'] !== 'active') {
        http_response_code(403);
        echo json_encode(['error' => 'This account is not active']);
        exit;
    }
    $user['sub'] = (int)$fresh['id'];
    $user['name'] = $fresh['name'];
    $user['email'] = $fresh['email'];
    $user['role'] = $fresh['role'];
    $user['status'] = $fresh['status'];
    return $user;
}

/** Call after require_auth() when the endpoint is admin/manager-only. */
function require_role(array $user, array $allowed): void {
    if (!in_array($user['role'] ?? '', $allowed, true)) {
        http_response_code(403);
        echo json_encode(['error' => 'Forbidden']);
        exit;
    }
}