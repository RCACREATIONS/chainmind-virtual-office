-- ChainMind Team Collaboration Portal
-- Fresh install schema (MySQL 5.7+/8.0, MariaDB 10.4+)

CREATE DATABASE IF NOT EXISTS chainmind_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chainmind_portal;

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','manager','department_lead','member') NOT NULL DEFAULT 'member',
    title VARCHAR(120) DEFAULT NULL,
    status ENUM('active','invited','suspended') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE avatars (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    display_name VARCHAR(60) NOT NULL,
    body_color VARCHAR(7) NOT NULL DEFAULT '#6B21A8',
    accent_color VARCHAR(7) NOT NULL DEFAULT '#F5F3FF',
    body_shape ENUM('capsule','block') NOT NULL DEFAULT 'capsule',
    head_style ENUM('round','square') NOT NULL DEFAULT 'round',
    pos_x FLOAT NOT NULL DEFAULT 0,
    pos_y FLOAT NOT NULL DEFAULT 0,
    pos_z FLOAT NOT NULL DEFAULT 0,
    rot_y FLOAT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6B21A8',
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_departments (
    user_id INT NOT NULL,
    department_id INT NOT NULL,
    is_primary TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, department_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE teams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6B21A8',
    department_id INT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE team_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    team_id INT NOT NULL,
    user_id INT NOT NULL,
    role_in_team ENUM('lead','member') NOT NULL DEFAULT 'member',
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_membership (team_id, user_id),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    team_id INT DEFAULT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    status ENUM('todo','in_progress','review','done') NOT NULL DEFAULT 'todo',
    priority ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
    created_by INT NOT NULL,
    due_date DATE DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE task_assignees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    user_id INT NOT NULL,
    UNIQUE KEY unique_assignment (task_id, user_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE clock_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    clock_in DATETIME NOT NULL,
    clock_out DATETIME DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    leave_type VARCHAR(60) NOT NULL DEFAULT 'Annual leave',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    approved_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE announcements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(180) NOT NULL,
    body TEXT NOT NULL,
    audience VARCHAR(30) NOT NULL DEFAULT 'company',
    department_id INT DEFAULT NULL,
    team_id INT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE calendar_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(180) NOT NULL,
    description TEXT,
    start_at DATETIME NOT NULL,
    end_at DATETIME DEFAULT NULL,
    location VARCHAR(180) DEFAULT NULL,
    team_id INT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE shared_resources (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(180) NOT NULL,
    url VARCHAR(1000) NOT NULL,
    description TEXT,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE invitations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(150) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role ENUM('admin','manager','department_lead','member') NOT NULL DEFAULT 'member',
    title VARCHAR(120) DEFAULT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME DEFAULT NULL,
    invited_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    actor_user_id INT DEFAULT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id INT DEFAULT NULL,
    details TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE meeting_rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(120) DEFAULT NULL,
    created_by INT NOT NULL,
    team_id INT DEFAULT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME DEFAULT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE realtime_presence (
    user_id INT NOT NULL PRIMARY KEY,
    call_room VARCHAR(64) DEFAULT NULL,
    pos_x FLOAT NOT NULL DEFAULT 0,
    pos_y FLOAT NOT NULL DEFAULT 0,
    pos_z FLOAT NOT NULL DEFAULT 0,
    rot_y FLOAT NOT NULL DEFAULT 0,
    last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_last_seen (last_seen),
    INDEX idx_call_room (call_room)
) ENGINE=InnoDB;

CREATE TABLE realtime_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    scope VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    from_user_id INT NOT NULL,
    to_user_id INT DEFAULT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_scope_id (scope, id),
    INDEX idx_to_user_id (to_user_id, id)
) ENGINE=InnoDB;

-- Seed admin. Change this password immediately after first login.
INSERT INTO users (name, email, password_hash, role, title) VALUES
('Richard Ayeni', 'admin@chainmind.local', '$2b$10$VT.OA/b1VRe1r3FLEgeN9O/KUjZCT6dSmDSGkhTOIoX6Wq8oQyMHG', 'admin', 'CEO');