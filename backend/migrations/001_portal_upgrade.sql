-- Run this once against an existing ChainMind database.
-- New installs should use ../schema.sql instead.
USE chainmind_portal;

ALTER TABLE users MODIFY role ENUM('admin','manager','department_lead','member') NOT NULL DEFAULT 'member';
ALTER TABLE users MODIFY status ENUM('active','invited','suspended') NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS departments (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6B21A8', created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS user_departments (
    user_id INT NOT NULL, department_id INT NOT NULL, is_primary TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, department_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
) ENGINE=InnoDB;
ALTER TABLE teams ADD COLUMN department_id INT DEFAULT NULL;
ALTER TABLE teams ADD CONSTRAINT fk_teams_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, leave_type VARCHAR(60) NOT NULL DEFAULT 'Annual leave',
    start_date DATE NOT NULL, end_date DATE NOT NULL, reason TEXT,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending', approved_by INT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS announcements (
    id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(180) NOT NULL, body TEXT NOT NULL,
    audience VARCHAR(30) NOT NULL DEFAULT 'company', department_id INT DEFAULT NULL, team_id INT DEFAULT NULL,
    created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS calendar_events (
    id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(180) NOT NULL, description TEXT, start_at DATETIME NOT NULL,
    end_at DATETIME DEFAULT NULL, location VARCHAR(180) DEFAULT NULL, team_id INT DEFAULT NULL, created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS shared_resources (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(180) NOT NULL, url VARCHAR(1000) NOT NULL,
    description TEXT, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS invitations (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(150) NOT NULL, name VARCHAR(100) NOT NULL,
    role ENUM('admin','manager','department_lead','member') NOT NULL DEFAULT 'member', title VARCHAR(120) DEFAULT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME NOT NULL, accepted_at DATETIME DEFAULT NULL,
    invited_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL, used_at DATETIME DEFAULT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_user_id INT DEFAULT NULL, action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(60) NOT NULL, entity_id INT DEFAULT NULL, details TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;