-- Preserve the currently published edition while staff prepare its replacement.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE content ADD COLUMN published_snapshot jsonb;
UPDATE content c SET published_snapshot=to_jsonb(c)-'published_snapshot'
 WHERE state='published';
ALTER TABLE content ADD CONSTRAINT publication_snapshot_object
 CHECK(published_snapshot IS NULL OR jsonb_typeof(published_snapshot)='object');
CREATE UNIQUE INDEX content_publication_route ON content
 ((published_snapshot->>'kind'),(published_snapshot->>'locale'),(published_snapshot->>'slug'))
 WHERE published_snapshot IS NOT NULL;
CREATE VIEW published_content AS
 SELECT p.id,p.kind,p.slug,p.locale,p.title,p.summary,p.body,p.metadata,p.state,
        p.publish_at,p.author_id,p.revision,p.updated_at
 FROM content c CROSS JOIN LATERAL
 jsonb_populate_record(NULL::content,COALESCE(c.published_snapshot,to_jsonb(c))) p
 WHERE c.published_snapshot IS NOT NULL OR c.state='published';
REVOKE ALL ON published_content FROM PUBLIC;
