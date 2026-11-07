-- The default personality, when it still has every other tool group, gets the new one for changing Sling's setup.
UPDATE "personalities" SET "tools" = "tools" || '["setup"]'::jsonb, "revision" = "revision" + 1 WHERE "is_default" AND "tools" @> '["commands","coding","apps","deploys"]'::jsonb AND NOT "tools" @> '["setup"]'::jsonb;
