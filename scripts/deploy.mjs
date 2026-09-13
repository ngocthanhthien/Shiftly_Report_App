import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Workers Builds supplies a frontend-only name/tag override. It must not
// rename the separately configured compatibility backend during this release.
export function backendEnvironment(environment){
  const env={...environment};
  delete env.WRANGLER_CI_OVERRIDE_NAME;
  delete env.WRANGLER_CI_MATCH_TAG;
  delete env.WRANGLER_CI_GENERATE_PREVIEW_ALIAS;
  return env;
}
export function targets(){
  const frontend=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const backend=readFileSync(new URL('../cloudflare/wrangler.toml',import.meta.url),'utf8');
  if(frontend.name!=='shiftly-report-app' || !/^name = "shiftly-report-sync"$/m.test(backend)) throw Error('Unexpected deployment targets');
  if(!backend.includes('96bcf77a519793b49f2d4c1c041ef0fb') || frontend.account_id!=='96bcf77a519793b49f2d4c1c041ef0fb') throw Error('Unexpected account');
  return [['cloudflare/wrangler.toml',backendEnvironment(process.env)],['wrangler.jsonc',process.env]];
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
  for(const [config,env] of targets()){
    const result=spawnSync(process.execPath,[cli,'deploy','--config',config],{stdio:'inherit',env});
    if(result.error) throw result.error;
    if(result.status!==0) process.exit(result.status||1);
  }
}
