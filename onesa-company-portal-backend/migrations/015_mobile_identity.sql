-- Add the opt-in Mobile product vocabulary without issuing access or changing any account.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE identity_product_access DROP CONSTRAINT identity_product_access_product_check;
ALTER TABLE identity_product_access DROP CONSTRAINT identity_product_access_role_check;
ALTER TABLE identity_product_access DROP CONSTRAINT identity_product_access_check;
ALTER TABLE identity_product_access ADD CONSTRAINT identity_product_access_product_check CHECK(product IN ('ai','drone','robot','mobile'));
ALTER TABLE identity_product_access ADD CONSTRAINT identity_product_access_role_check CHECK(role IN ('user','viewer','operator','admin','operations','support','finance','agent','auditor','customer'));
ALTER TABLE identity_product_access ADD CONSTRAINT identity_product_access_check CHECK(
 (product='ai' AND role IN ('user','admin')) OR
 (product IN ('drone','robot') AND role IN ('viewer','operator','admin')) OR
 (product='mobile' AND role IN ('admin','operations','support','finance','agent','auditor','customer'))
);
