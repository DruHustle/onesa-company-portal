import type { Pool, PoolClient } from 'pg';

type Connection = Pick<Pool | PoolClient, 'query'>;

export async function provisionApplicationRole(owner:Connection, password:string, role='onesa_portal_app') {
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(role)||password.length<32)throw new Error('Use a valid role and a generated password of at least 32 characters');
 const existing=await owner.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role]);
 if(existing.rows[0]&&Object.values(existing.rows[0]).some(Boolean))throw new Error('Existing application role has elevated privileges; operator review required');
 if(!existing.rowCount){
  const statement=(await owner.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text)",[role,password])).rows[0].format;
  await owner.query(statement);
 }
 const quoted='"'+role+'"';
 await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
 const tables=await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'");
 for(const {tablename} of tables.rows){
  const table='"'+String(tablename).replaceAll('"','""')+'"';
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${table} TO ${quoted}`);
 }
 const publicationView=await owner.query("SELECT to_regclass('public.published_content') AS relation");
 if(publicationView.rows[0]?.relation)await owner.query(`GRANT SELECT ON public.published_content TO ${quoted}`);
 await owner.query(`GRANT SELECT ON TABLE public.schema_migrations TO ${quoted}`);
 await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoted}`);
}

export async function applicationRoleStatus(connection:Connection) {
 const result=await connection.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated_role, has_schema_privilege(current_user,'public','CREATE') AS schema_create, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS relation_owner, has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS migration_write, EXISTS(SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AND pg_has_role(current_user,r.oid,'MEMBER')) AS elevated_membership FROM pg_roles WHERE rolname=current_user");
 const reasons=result.rowCount===1?Object.entries(result.rows[0]).filter(([,value])=>value!==false).map(([name])=>name):['role_missing'];
 return {safe:reasons.length===0,reasons};
}

export async function applicationRoleSafe(connection:Connection) {
 return (await applicationRoleStatus(connection)).safe;
}
