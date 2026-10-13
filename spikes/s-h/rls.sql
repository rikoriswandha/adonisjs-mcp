CREATE ROLE sh_reader LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE sh_posts (id integer PRIMARY KEY, tenant_id text NOT NULL, title text NOT NULL, overlap integer NOT NULL);
INSERT INTO sh_posts VALUES (1, 'a', 'A private', 7), (2, 'b', 'B private', 7);
ALTER TABLE sh_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sh_posts FORCE ROW LEVEL SECURITY;
CREATE POLICY sh_tenant_select ON sh_posts FOR SELECT TO sh_reader
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
GRANT SELECT ON sh_posts TO sh_reader;
