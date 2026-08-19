ALTER TABLE answer_reply_deliveries
  DROP CONSTRAINT answer_reply_deliveries_state_check,
  DROP CONSTRAINT answer_reply_deliveries_check;

ALTER TABLE answer_reply_deliveries
  ADD CONSTRAINT answer_reply_deliveries_state_check CHECK (state IN (
    'prepared', 'sending', 'sent',
    'permission_blocked', 'reconciliation_required', 'not_sent_reconciled'
  )),
  ADD CONSTRAINT answer_reply_deliveries_content_shape_check CHECK (
    (state IN ('prepared', 'sending') AND prepared_reply_text IS NOT NULL)
    OR (state IN (
      'sent', 'permission_blocked', 'reconciliation_required', 'not_sent_reconciled'
    ) AND prepared_reply_text IS NULL)
  );

ALTER TABLE answer_reply_delivery_events
  DROP CONSTRAINT answer_reply_delivery_events_event_type_check;

ALTER TABLE answer_reply_delivery_events
  ADD CONSTRAINT answer_reply_delivery_events_event_type_check CHECK (event_type IN (
    'prepared', 'send_started', 'sent',
    'permission_blocked', 'reconciliation_required', 'not_sent_reconciled',
    'safe_notice_send_started', 'safe_notice_sent'
  ));
