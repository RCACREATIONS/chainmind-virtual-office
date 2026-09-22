<?php
/**
 * ChainMind Team Portal — Central Configuration
 * Copy this file to config.local.php on your server and fill in real values.
 * NEVER commit real credentials to git.
 */

// ---- Database ----
define('DB_HOST', getenv('CM_DB_HOST') ?: '127.0.0.1');
define('DB_NAME', getenv('CM_DB_NAME') ?: 'charle39_team');
define('DB_USER', getenv('CM_DB_USER') ?: 'charle39_team');
// Set CM_DB_PASS in the server environment. Do not commit a real password.
define('DB_PASS', getenv('CM_DB_PASS') ?: 'Tmsi.admin1');

// ---- App ----
define('APP_URL', getenv('CM_APP_URL') ?: 'https://chainmind.com.ng/chainmind_portal/backend/api/');
define('FRONTEND_URL', getenv('CM_FRONTEND_URL') ?: 'https://chainmind.com.ng/chainmind_portal/public');
// Set CM_JWT_SECRET to a new value on the server (for example:
// openssl rand -hex 32). Never use a value copied from this package.
define('JWT_SECRET', getenv('CM_JWT_SECRET') ?: '');
define('JWT_TTL_SECONDS', 60 * 60 * 12); // 12 hour session token

// ---- CORS: restrict this to your real frontend origin(s) in production ----
define('ALLOWED_ORIGINS', [
    'https://chainmind.com.ng',
    'https://www.chainmind.com.ng',
    'http://localhost:8080',
]);

// ---- Brand theme (also used by the frontend) ----
define('THEME_PRIMARY', '#6B21A8');   // Barney purple, from the ChainMind mark
define('THEME_PRIMARY_DARK', '#4C1D7A');
define('THEME_LIGHT', '#F5F3FF');
define('THEME_WHITE', '#FFFFFF');

date_default_timezone_set('Africa/Lagos');
error_reporting(E_ALL);
ini_set('display_errors', '0'); // never display raw errors in production
