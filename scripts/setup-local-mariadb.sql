-- Run this once in HeidiSQL (connected as root): File → Load SQL file → Execute (F9).
-- Creates the empty database; app creates table `airdrop_jobs` on first API use.

CREATE DATABASE IF NOT EXISTS airdrop_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Optional: dedicated local user (uncomment and set a password, then use same in .env)
-- CREATE USER IF NOT EXISTS 'makalu_app'@'localhost' IDENTIFIED BY 'your_password_here';
-- GRANT ALL PRIVILEGES ON airdrop_db.* TO 'makalu_app'@'localhost';
-- FLUSH PRIVILEGES;
