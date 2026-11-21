-- Correct only the original unverified seeded role inference; preserve reviewed records.
UPDATE facts SET value=NULL, status='missing', source='Founder supplied; director appointment requires official register evidence'
WHERE key='director' AND status='supplied' AND value='Andrew Gotora' AND source='User implementation directive';
INSERT INTO facts(key,value,status,source) VALUES
('founder','Andrew Gotora','supplied','Owner audit directive 2026-10-09; no ownership percentage inferred'),
('founding_year','2026','supplied','Owner audit directive 2026-10-09; exact incorporation date unverified')
ON CONFLICT(key) DO NOTHING;
