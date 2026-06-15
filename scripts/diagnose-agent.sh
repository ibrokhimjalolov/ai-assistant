#!/bin/sh
# Diagnose why an agent's agent.db is missing / the runtime won't start.
# Read-only. Run on the machine where the runtime/monitor lives:
#   sh diagnose-agent.sh
ROOT="$HOME/Library/Application Support/agent-runtime"
CFG="$ROOT/config.json"
echo "host: $(whoami)@$(hostname -s)   HOME=$HOME"
echo "appdata: $ROOT"
echo

echo "== 1. App Data present? =="
[ -d "$ROOT" ] && echo "  ROOT dir: present" || echo "  ROOT dir: MISSING — the runtime daemon has never run on this Mac"
[ -f "$CFG" ] && echo "  config.json: present" || echo "  config.json: MISSING"
echo

echo "== 2. Daemon status =="
if launchctl list 2>/dev/null | grep -q agent-runtime; then
  launchctl list | grep agent-runtime | awk '{print "  launchd job: PID="$1"  laststatus="$2"  label="$3}'
else
  echo "  launchd job: NOT loaded — the runtime daemon is not running on this Mac"
fi
[ -f "$HOME/Library/LaunchAgents/uz.domo.agent-runtime.plist" ] && echo "  plist: installed" || echo "  plist: NOT installed (runtime not deployed here?)"
echo

echo "== 3. Last startup error (the daemon logs the real reason here) =="
if [ -f "$ROOT/logs/agent-runtime.err.log" ]; then
  tail -n 40 "$ROOT/logs/agent-runtime.err.log" | grep -iE "config|error|fatal" | tail -n 8 || echo "  (no config/error lines in err.log)"
else
  echo "  (no err.log)"
fi
[ -f "$ROOT/logs/agent-runtime.log" ] && grep -iE "config error|config:" "$ROOT/logs/agent-runtime.log" | tail -n 3
echo

echo "== 4. Config validation (runtime's exact rules) =="
if command -v node >/dev/null 2>&1; then
node - "$CFG" <<'NODE' 2>/dev/null || echo "  (node failed)"
const fs=require('fs'); const NAME=/^[a-z0-9_-]+$/;
let raw; try{raw=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));}catch(e){console.log('  INVALID JSON:',e.message);process.exit(0);}
let list = Array.isArray(raw.agents)?raw.agents:(raw.telegramBotToken?[{name:'default',...raw}]:null);
if(!list){console.log('  no agents[] array and no top-level telegramBotToken');process.exit(0);}
const seen=new Set(); let ok=true;
list.forEach((a,i)=>{
  const where=a&&a.name?`agent "${a.name}"`:`agents[${i}]`; const e=[];
  if(typeof a.name!=='string'||!NAME.test(a.name)) e.push('name must match ^[a-z0-9_-]+$ (lowercase, digits, - , _)');
  else if(seen.has(a.name)) e.push('duplicate name'); else seen.add(a.name);
  if(!a.telegramBotToken) e.push('telegramBotToken required');
  if(!Array.isArray(a.whitelist)||a.whitelist.length===0||!a.whitelist.every(n=>Number.isInteger(n))) e.push('whitelist must be non-empty array of INTEGER Telegram IDs');
  if(!a.agentHome||!fs.existsSync(a.agentHome)) e.push('agentHome does NOT exist on disk: '+a.agentHome);
  else if(!fs.statSync(a.agentHome).isDirectory()) e.push('agentHome is not a directory: '+a.agentHome);
  console.log(e.length?`  X ${where}: ${e.join('; ')}`:`  OK ${where}  (agentHome ${a.agentHome})`);
  if(e.length) ok=false;
});
console.log(ok?'  => CONFIG VALID: daemon should start every agent and create its DB on (re)start':'  => CONFIG REJECTED: daemon exits(1) at startup, NO DBs created until fixed');
NODE
else
  echo "  node not on PATH — rely on err.log (section 3) for the exact reason"
fi
echo

echo "== 5. Agent DBs on disk =="
if [ -d "$ROOT/agents" ]; then
  for d in "$ROOT/agents"/*/; do
    [ -d "$d" ] || continue; n=$(basename "$d")
    [ -f "$d/agent.db" ] && echo "  OK  $n  -> has agent.db" || echo "  X   $n  -> NO agent.db (dir exists but daemon never opened a DB here)"
  done
else
  echo "  no agents/ dir yet"
fi
echo
echo "== verdict hints =="
echo "  - Section 4 shows 'X ... agentHome does NOT exist' -> create that dir, then restart daemon."
echo "  - Section 4 'CONFIG VALID' but section 5 shows NO agent.db and section 2 a stale/old PID -> restart the daemon."
echo "  - Section 2 'NOT loaded' / 'plist NOT installed' -> the runtime daemon isn't running here; only the monitor reads state."
echo "  restart: launchctl kickstart -k \"gui/\$(id -u)/uz.domo.agent-runtime\""
