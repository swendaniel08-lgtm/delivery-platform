/*
 * Order participants — the ownership check for chat.
 *
 * SECURITY. Before this table existed, chat authorisation only asked "is the
 * caller a customer?" and "is the 30-minute window still open?" — never "is
 * the caller on THIS order". Any signed-in customer could read any order's
 * transcript by guessing an id, and delivery chats routinely contain gate
 * codes, flat numbers and when a house is empty.
 *
 * Written from consumed order events, not by chat itself. Momentary staleness
 * is acceptable (a rider assigned a second ago waits a beat for chat); being
 * wrong in the permissive direction is not, so an absent row denies access.
 */

CREATE TABLE IF NOT EXISTS order_participants (
  order_id    UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  rider_id    UUID,
  vendor_id   UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_participants_customer_idx
  ON order_participants (customer_id);
CREATE INDEX IF NOT EXISTS order_participants_rider_idx
  ON order_participants (rider_id) WHERE rider_id IS NOT NULL;
