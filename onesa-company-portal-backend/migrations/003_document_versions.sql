CREATE UNIQUE INDEX files_one_successor ON files(parent_id) WHERE parent_id IS NOT NULL;
