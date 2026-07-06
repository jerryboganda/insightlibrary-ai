-- Documents carry the frontend's folder assignment so Document.folderId
-- round-trips (create -> list/get) and `GET /api/documents?folderId=` can
-- filter server-side. Folders become a first-class entity in a later phase;
-- until then the id is an opaque client string (additive, nullable column).
ALTER TABLE documents ADD COLUMN folder_id text;
CREATE INDEX idx_documents_tenant_folder ON documents (tenant_id, folder_id);
