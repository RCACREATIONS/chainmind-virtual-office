-- Promote the ChainMind management login so the invite/team/department
-- controls are available after the next portal load.
UPDATE users
SET role = 'admin', status = 'active'
WHERE email = 'admin@chainmind.com.ng';