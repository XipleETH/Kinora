#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const required = [
  'R2_ENABLED',
  'R2_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];
const optional = ['R2_PUBLIC_BASE_URL'];

function runCommand(commandString) {
  // Use shell:true for Windows compatibility (npx.cmd)
  const r = spawnSync(commandString, { stdio: 'inherit', shell: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${commandString} failed with code ${r.status}`);
}

function runCommandWithInput(commandString, inputStr) {
  const r = spawnSync(commandString, {
    shell: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    input: inputStr
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${commandString} failed with code ${r.status}`);
}

function ensureDevvitAvailable() {
  const check = spawnSync('npx devvit --version', { stdio: 'inherit', shell: true });
  if (check.status !== 0) {
    console.error('\n[secrets] Devvit CLI no está disponible via npx. Ejecuta `npm install` y prueba `npx devvit --version`.');
    process.exit(1);
  }
}

(async function main(){
  try {
    ensureDevvitAvailable();
    const toSet = [];
    for (const k of required) {
      const v = process.env[k];
      if (!v || !String(v).trim()) {
        console.error(`[secrets] Falta la variable requerida ${k} en el entorno (.env)`);
        process.exit(1);
      }
      toSet.push([k, v]);
    }
    for (const k of optional) {
      const v = process.env[k];
      if (v && String(v).trim()) toSet.push([k, v]);
    }

    console.log('\n[secrets] Enviando secretos a Devvit (no se imprimen valores)...');
    // Login hint if not already logged in
    console.log('[secrets] Si aparece un prompt de login, ejecuta:  npm run settings:login');

    for (const [k, v] of toSet) {
  console.log(`[secrets] settings set ${k}`);
      // Provide value via stdin to satisfy interactive input without echoing the value
      const input = String(v) + '\n';
      runCommandWithInput(`npx devvit settings set ${k}`, input);
    }

  console.log('\n[secrets] Listo. Settings configurados en Devvit.');
  } catch (e) {
    console.error('[secrets] Error:', e?.message || e);
    process.exit(1);
  }
})();
