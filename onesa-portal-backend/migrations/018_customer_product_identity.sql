-- Product approval identifies the person; customer records and tenant membership
-- remain in the independent product databases. No existing grants are changed.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE identity_product_access DROP CONSTRAINT identity_product_access_product_check;
ALTER TABLE identity_product_access DROP CONSTRAINT identity_product_access_check;
ALTER TABLE identity_product_access ADD CONSTRAINT identity_product_access_product_check CHECK(product IN ('ai','drone','robot','mobile','farmer','logistics','pasofi','factory'));
ALTER TABLE identity_product_access ADD CONSTRAINT identity_product_access_check CHECK(
 (product IN ('farmer','logistics','factory') AND role='user') OR
 (product='pasofi' AND role='customer') OR
 (product='ai' AND role IN ('user','admin')) OR
 (product IN ('drone','robot') AND role IN ('viewer','operator','admin')) OR
 (product='mobile' AND role IN ('admin','operations','support','finance','agent','auditor','customer'))
);
