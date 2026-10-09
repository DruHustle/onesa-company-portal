import ts from 'typescript-eslint';
export default ts.config({ignores:['dist/**','.next/**','next-env.d.ts']}, ...ts.configs.recommended, {rules:{'@typescript-eslint/no-explicit-any':'error'}});
