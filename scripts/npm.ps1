# Run npm with a supported Node runtime already installed on PATH.
$ErrorActionPreference = 'Stop'
$ducelioNode = (Get-Command node -ErrorAction Stop).Source
$ducelioVersion = [version](& $ducelioNode -p 'process.versions.node')
if ($ducelioVersion -lt [version]'22.13.0') {
    throw 'Ducelio requires Node 22.13+; install Node 24 LTS and restart your terminal. No bundled runtime fallback is used.'
}
$ducelioNpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$ducelioNpmCli = Join-Path (Split-Path $ducelioNpmCommand) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $ducelioNpmCli)) { throw 'Cannot locate npm CLI next to npm.cmd. Install Node 24 LTS with npm.' }
$env:PATH = (Split-Path $ducelioNode) + ';' + $env:PATH
if (!$env:npm_config_cache) { $env:npm_config_cache = Join-Path (Split-Path $PSScriptRoot) 'work/npm-cache' }
& $ducelioNode $ducelioNpmCli @args
exit $LASTEXITCODE
