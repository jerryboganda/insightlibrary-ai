-- 0013 — ontology schema editor persistence (gap B23) + custom-ontology support
-- (gap A11).
--
-- The admin ontology schema editor (admin/ontology/[id]) previously edited a
-- hardcoded, non-persisted schema. Its editable layer — the entity/class list,
-- per-entity properties, and the auto-merge (conflict) strategy — is NOT a
-- stored concept today, so it gets its own per-org store here, keyed by the
-- ontology slug the concepts dictionary already groups by (mesh/mondo/custom/…).
-- GET /api/ontologies/[id]/schema synthesizes a real read-only view from the
-- concepts tables when no row exists; PUT persists edits into this table.
--
-- ADDITIVE ONLY, idempotent. Runtime code (lib/server/ontology/schema-store.ts)
-- tolerates the table being absent (falls back to the concept-derived view), so
-- deploy order is safe either way.

CREATE TABLE IF NOT EXISTS ontology_schemas (
	-- One editable schema per (org, ontology slug). `ontology` matches
	-- concepts.ontology (e.g. 'custom', 'mesh'); the surfaced id is 'ont_'||ontology.
	org_id text NOT NULL REFERENCES organizations(id),
	ontology text NOT NULL,
	-- Display name shown in the editor header (defaults to the ontology label).
	name text,
	-- 'active' | 'draft' — publish state controlled by the editor's Publish button.
	status text NOT NULL DEFAULT 'draft',
	-- Editable schema definition: { entities: [...], properties: {entityId: [...]},
	-- mergeStrategy: {entityId: 'append'|'review'} } — validated by the route/store.
	schema jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamp NOT NULL DEFAULT now(),
	PRIMARY KEY (org_id, ontology)
);
