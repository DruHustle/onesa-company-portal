export const roles=['owner','administrator','editor','business','hr','viewer'] as const;
export type Role=typeof roles[number];
export type Actor={id:string;role:Role;csrf:string;email:string};
export const permitted=(role:Role,allowed:readonly Role[])=>role==='owner'||allowed.includes(role);
export const permissions={content:['administrator','editor'],publish:['administrator'],enquiries:['administrator','business'],applications:['administrator','hr'],files:['administrator','business'],users:['administrator'],audit:['administrator']} as const;
