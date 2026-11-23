-- A small database with one of everything the upgrade must carry over: the data API's roles (one with a password and a setting), a table
-- with row-level security and every kind of column the app stores, a sequence that has moved on, an index, a view, a function with its
-- trigger, grants, and a second database.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'the-data-api-password';
GRANT anon, authenticated, service_role TO authenticator;
ALTER ROLE authenticator SET statement_timeout = '8s';

CREATE TYPE public.part_kind AS ENUM ('made', 'bought', 'assembly');
CREATE TABLE public.parts (
  id bigserial PRIMARY KEY,
  owner text NOT NULL,
  kind public.part_kind NOT NULL DEFAULT 'made',
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  price numeric(12, 4),
  weight double precision,
  made_at timestamptz NOT NULL DEFAULT now(),
  drawing bytea,
  tags text[],
  dropped_later int
);
INSERT INTO public.parts (owner, kind, spec, price, weight, made_at, drawing, tags)
SELECT CASE WHEN g % 3 = 0 THEN 'alice' ELSE 'bob' END,
       (ARRAY['made', 'bought', 'assembly'])[1 + g % 3]::public.part_kind,
       jsonb_build_object('n', g, 'name', 'part ' || g, 'dims', jsonb_build_array(g * 1.5, g / 7.0)),
       g * 1.2345, sqrt(g), timestamptz '2026-01-01 00:00:00+00' + g * interval '37 minutes',
       decode(md5(g::text), 'hex'), ARRAY['t' || g, NULL, 'é']
FROM generate_series(1, 500) g;
-- a dropped column: its position is gone from the copy, which must still compare as the same table
ALTER TABLE public.parts DROP COLUMN dropped_later;
DELETE FROM public.parts WHERE id % 50 = 0;
CREATE INDEX parts_owner_kind ON public.parts (owner, kind) WHERE price > 10;
ALTER TABLE public.parts ADD CONSTRAINT price_not_negative CHECK (price >= 0);

ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_parts ON public.parts FOR SELECT TO authenticated USING (owner = current_setting('test.owner', true));
REVOKE ALL ON public.parts FROM PUBLIC, anon;
GRANT SELECT ON public.parts TO authenticated;
GRANT ALL ON public.parts TO service_role;
GRANT USAGE ON SEQUENCE public.parts_id_seq TO service_role;

CREATE VIEW public.dear_parts AS SELECT id, owner, price FROM public.parts WHERE price > 500;
CREATE FUNCTION public.touch_made_at() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.made_at := coalesce(NEW.made_at, now());
  RETURN NEW;
END
$fn$;
CREATE TRIGGER parts_touch BEFORE INSERT ON public.parts FOR EACH ROW EXECUTE FUNCTION public.touch_made_at();
CREATE FUNCTION public.part_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT count(*) FROM public.parts $fn$;
REVOKE ALL ON FUNCTION public.part_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.part_count() TO authenticated;

CREATE DATABASE archive;
\connect archive
CREATE TABLE public.old_quotes (id int PRIMARY KEY, total numeric NOT NULL);
INSERT INTO public.old_quotes SELECT g, g * 10.5 FROM generate_series(1, 40) g;
