-- 0012 — research_projects: the persistent backend for the Research suite (gap B10).
-- ONE table serves all four tools (argument map, compare matrix, report, timeline):
-- the tool-specific document lives in the `data` JSONB blob, discriminated by
-- `type`. The Research hub lists/creates/opens these rows; each tool page loads,
-- edits and saves its own project via GET/PATCH /api/research/[id]. Replaces the
-- static mockups that had no server persistence whatsoever.
--
-- org_id is FK-constrained to organizations(id) like the other org-scoped tables
-- (sources/topics/…); the create route ensures a minimal org row exists first,
-- matching the sources-registry convention (better-auth orgs are not yet mirrored
-- into the app organizations table — C10).
-- ADDITIVE ONLY, idempotent.

CREATE TABLE IF NOT EXISTS research_projects (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	type text NOT NULL,
	title text NOT NULL,
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_by text,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

-- Hub listing: org's projects, optionally filtered by tool type, newest first.
CREATE INDEX IF NOT EXISTS research_projects_org_type_idx
	ON research_projects (org_id, type, updated_at DESC);
