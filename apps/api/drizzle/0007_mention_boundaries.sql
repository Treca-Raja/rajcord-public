CREATE OR REPLACE FUNCTION maintain_message_features() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM message_mentions WHERE message_id=NEW.id;
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM message_pins WHERE message_id=NEW.id;
    DELETE FROM message_reactions WHERE message_id=NEW.id;
  ELSE
    INSERT INTO message_mentions(message_id,user_id)
    SELECT NEW.id,u.id FROM users u JOIN conversations c ON c.id=NEW.conversation_id
    WHERE u.status='approved' AND u.id<>NEW.author_id
      AND translate(NEW.body,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
        ~ ('(^|[^[:alnum:]_@])@' || u.username || '($|[^[:alnum:]_])')
      AND (c.kind='channel' OR (
        EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id AND h.end_seq IS NULL)
        AND EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id
          AND NEW.seq>=h.start_seq AND (h.end_seq IS NULL OR NEW.seq<=h.end_seq))
      ));
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Rebuild derived recipients without changing messages, cursors or historical membership.
DELETE FROM message_mentions;--> statement-breakpoint
INSERT INTO message_mentions(message_id,user_id)
SELECT m.id,u.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
JOIN users u ON u.id<>m.author_id
WHERE m.deleted_at IS NULL
  AND translate(m.body,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
    ~ ('(^|[^[:alnum:]_@])@' || u.username || '($|[^[:alnum:]_])')
  AND (c.kind='channel' OR (
    EXISTS(SELECT 1 FROM memberships h WHERE h.conversation_id=c.id AND h.user_id=u.id
      AND m.seq>=h.start_seq AND (h.end_seq IS NULL OR m.seq<=h.end_seq))
  ));