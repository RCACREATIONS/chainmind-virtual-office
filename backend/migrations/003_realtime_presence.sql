-- Run this once against an existing ChainMind database.
-- New installs using backend/schema.sql already include these tables.
USE chainmind_portal;

CREATE TABLE IF NOT EXISTS realtime_presence (
    user_id INT NOT NULL PRIMARY KEY,
    call_room VARCHAR(64) DEFAULT NULL,
    pos_x FLOAT NOT NULL DEFAULT 0,
    pos_y FLOAT NOT NULL DEFAULT 0,
    pos_z FLOAT NOT NULL DEFAULT 0,
    rot_y FLOAT NOT NULL DEFAULT 0,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_realtime_presence_last_seen (last_seen),
    INDEX idx_realtime_presence_call_room (call_room)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS realtime_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    scope VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    from_user_id INT NOT NULL,
    to_user_id INT DEFAULT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_realtime_events_scope_id (scope, id),
    INDEX idx_realtime_events_to_user_id (to_user_id, id)
) ENGINE=InnoDB;