#!/usr/bin/env node
// CP2F credential-safe wrapper for the pinned Supabase CLI in LINKED mode.
//
//   node --env-file=<acceptance .env.local> scripts/acceptance/supabase-linked-cli.mjs --cli=<dir with supabase@2.120.0 installed> --workdir=<deploy worktree> -- <supabase args...>
//
// The database password is taken in-process from ACCEPTANCE_DATABASE_URL and
// handed to the CLI ONLY as SUPABASE_DB_PASSWORD in the child environment:
// never a command-line argument (no --password, no --db-url), never printed,
// never written to a file or shell history. Setting it also stops the CLI
// from creating a temporary login role through the Management API.
// The child receives a minimal environment (no other acceptance secret).
// Refuses: any --password/--db-url/--local argument, a workdir not linked to
// the acceptance project, or a pooler that is not the acceptance pooler.
// Every output line is scrubbed of the password before it is shown.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isApprovedDbPush } from "./supabase-linked-command.mjs";

const EXPECTED_REF = "blqaomssojfxaxskcyxd";
const sep = process.argv.indexOf("--");
const own = process.argv.slice(2, sep < 0 ? undefined : sep);
const cli = sep < 0 ? [] : process.argv.slice(sep + 1);
const workdir = own.find((a) => a.startsWith("--workdir="))?.slice(10);
const cliDir = own.find((a) => a.startsWith("--cli="))?.slice(6);
const fail = (m) => {
  console.error(`REFUSED: ${m}`);
  process.exit(2);
};
if (!workdir) fail("--workdir is required");
if (!cliDir)
  fail("--cli is required (a directory with the pinned CLI installed)");
// The pinned CLI, run by this Node binary directly: no shell, no npx.
const cliPackage = join(resolve(cliDir), "node_modules", "supabase");
const cliVersion = JSON.parse(
  readFileSync(join(cliPackage, "package.json"), "utf8"),
).version;
if (cliVersion !== "2.120.0")
  fail("the pinned Supabase CLI 2.120.0 is required");
if (!isApprovedDbPush(cli))
  fail("Only approved db push --linked --skip-vault modes are permitted");
if (
  sep < 0 ||
  own.length !== 2 ||
  own.filter((a) => a.startsWith("--cli=")).length !== 1 ||
  own.filter((a) => a.startsWith("--workdir=")).length !== 1
)
  fail("Exactly one --cli and --workdir are required");

const temp = join(resolve(workdir), "supabase", ".temp");
const ref = readFileSync(join(temp, "project-ref"), "utf8").trim();
if (ref !== EXPECTED_REF) fail("workdir is not linked to ducelio-acceptance");
const pooler = new URL(readFileSync(join(temp, "pooler-url"), "utf8").trim());
if (
  decodeURIComponent(pooler.username) !== `postgres.${EXPECTED_REF}` ||
  !pooler.hostname.endsWith(".pooler.supabase.com")
)
  fail("linked pooler is not the acceptance project's session pooler");

const db = new URL(process.env.ACCEPTANCE_DATABASE_URL ?? "postgres://x");
if (decodeURIComponent(db.username) !== `postgres.${EXPECTED_REF}`)
  fail("ACCEPTANCE_DATABASE_URL is not the acceptance project's postgres user");
const password = decodeURIComponent(db.password);
if (!password) fail("ACCEPTANCE_DATABASE_URL carries no password");

const keep = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];
const env = Object.fromEntries(
  keep
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
env.SUPABASE_DB_PASSWORD = password;
env.DO_NOT_TRACK = "1";

const scrub = (text) => text.split(password).join("<redacted>");
const child = spawn(
  process.execPath,
  [
    join(cliPackage, "dist", "supabase.js"),
    ...cli,
    "--workdir",
    resolve(workdir),
  ],
  { env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (d) => process.stdout.write(scrub(String(d))));
child.stderr.on("data", (d) => process.stderr.write(scrub(String(d))));
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
