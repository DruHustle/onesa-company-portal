import {AdminPortal} from '@/features/admin/portal';
export default function Admin(){const environment=process.env.VERCEL_ENV==='preview'?'STAGING':process.env.NODE_ENV==='development'?'DEVELOPMENT':undefined;return <AdminPortal environment={environment}/>;}
