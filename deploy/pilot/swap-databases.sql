SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (:'target_database', :'staging_database')
  AND pid <> pg_backend_pid();

SELECT format(
  'ALTER DATABASE %I RENAME TO %I',
  :'target_database',
  :'previous_database'
) \gexec

SELECT format(
  'ALTER DATABASE %I RENAME TO %I',
  :'staging_database',
  :'target_database'
) \gexec
