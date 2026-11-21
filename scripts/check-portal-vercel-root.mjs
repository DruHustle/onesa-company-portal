import {existsSync, lstatSync, readFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";

const EXPECTED_ROOT = "onesa-company-portal-frontend";
const DEV_SOURCE = "onesa-portal-frontend";
const PROJECT_ID = "prj_91TBAfa7ByYzG6Q022gTbzI6iR2m";

/**
 * Fail closed if Vercel's fixed project Root Directory cannot be used by the
 * checked-out commit, or the temporary dev path mirror diverged.
 *
 * This is repository-source preflight; verifying the Vercel dashboard setting
 * itself also requires live access to that project.
 */
export function verifyPortalVercelRoot({
  root = resolve("."),
  targetBranch = process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || "",
  treeSha = relative => execFileSync("git", ["-C", root, "rev-parse", "HEAD:" + relative], {encoding:"utf8", timeout:5000}).trim(),
} = {}) {
  const c = JSON.parse(readFileSync(join(root, "infra/vercel/portal-root-contract.json"), "utf8"));
  if (c.schema !== 1 || c.root_directory !== EXPECTED_ROOT || c.dev_source_directory !== DEV_SOURCE ||
      c.vercel_project_id !== PROJECT_ID || c.vercel_project !== "onesa-company-portal" ||
      c.vercel_team !== "druhustles-projects") {
    throw Error("Portal Vercel root contract changed unexpectedly; review the Vercel project before deployment");
  }
  const checkDirectory = (relative, required) => {
    const path = join(root, relative);
    if (!existsSync(path)) {
      if (required) throw Error("Required Vercel frontend root is missing: " + relative);
      return false;
    }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("Vercel frontend path must be a real Git directory, not a symlink: " + relative);
    for (const file of ["package.json", "vercel.json", "next.config.mjs"]) {
      const target = join(path, file);
      if (!existsSync(target) || !lstatSync(target).isFile())
        throw Error("Vercel frontend is missing " + relative + "/" + file);
    }
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    if (typeof pkg.scripts?.build !== "string" || !pkg.scripts.build.includes("next build"))
      throw Error("Vercel root package lacks Next.js production build: " + relative);
    return true;
  };

  checkDirectory(EXPECTED_ROOT, true);
  const modern = checkDirectory(DEV_SOURCE, targetBranch === "dev");
  if (modern) {
    const legacyTree = treeSha(EXPECTED_ROOT);
    const modernTree = treeSha(DEV_SOURCE);
    if (!/^[0-9a-f]{40}$/.test(legacyTree) || !/^[0-9a-f]{40}$/.test(modernTree) ||
        legacyTree !== modernTree)
      throw Error("Vercel compatibility folder drift: synchronize " + EXPECTED_ROOT + " with " + DEV_SOURCE + " before merging");
  }
  return {project:c.vercel_project, projectId:c.vercel_project_id, rootDirectory:EXPECTED_ROOT,
    sourceDirectory:modern ? DEV_SOURCE : EXPECTED_ROOT, mirrorVerified:modern, branch:targetBranch};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {console.log(JSON.stringify({status:"PASS",...verifyPortalVercelRoot()}))}
  catch(e) {console.error(String(e.message||e)); process.exitCode=1}
}
