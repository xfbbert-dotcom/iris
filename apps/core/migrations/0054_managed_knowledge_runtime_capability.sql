UPDATE runtime_control_state
SET capabilities = capabilities || '{"updateManagedKnowledge":false}'::jsonb
WHERE NOT (capabilities ? 'updateManagedKnowledge');
