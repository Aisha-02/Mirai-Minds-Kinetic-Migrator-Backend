CREATE TYPE user_role AS ENUM ('admin', 'normal_user');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'normal_user';
