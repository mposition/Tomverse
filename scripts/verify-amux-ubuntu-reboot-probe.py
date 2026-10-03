"""Read-only Ubuntu AMUX reboot recovery snapshot for the local verifier."""

import hashlib
import json
import getpass
from pathlib import Path
import ssl
import subprocess
import urllib.request


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    return result.stdout.strip()


def unit_state(unit, user=False):
    prefix = ["systemctl", "--user"] if user else ["systemctl"]
    return {
        "active": command(*prefix, "is-active", unit),
        "enabled": command(*prefix, "is-enabled", unit),
    }


def panes():
    output = command(
        "tmux",
        "list-panes",
        "-a",
        "-F",
        "#{session_name}|#{pane_current_command}|#{pane_current_path}|#{pane_dead}",
    )
    result = []
    for line in output.splitlines():
        fields = line.split("|", 3)
        if len(fields) != 4:
            continue
        session, process, path, dead = fields
        result.append(
            {
                "session": session,
                "process": process,
                "path": path,
                "dead": dead,
                "gitRoot": command("git", "-C", path, "rev-parse", "--show-toplevel"),
            }
        )
    return result


binary = Path.home() / ".local/bin/amux-server-rs"
health = {"http": None, "status": None}
try:
    # The AMUX certificate is self-signed; only the loopback endpoint is queried.
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(
        "https://127.0.0.1:8824/api/health", context=context, timeout=8
    ) as response:
        body = json.load(response)
        health = {
            "http": response.status,
            "status": body.get("status") if isinstance(body, dict) else None,
        }
except (OSError, ValueError) as error:
    health["error"] = type(error).__name__

boot_epoch = None
for line in Path("/proc/stat").read_text().splitlines():
    if line.startswith("btime "):
        boot_epoch = int(line.split()[1])
        break

snapshot = {
    "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    "bootEpoch": boot_epoch,
    "units": {
        "server": unit_state("amux-server.service", user=True),
        "workers": unit_state("amux-worker-start.service", user=True),
        "tailscale": unit_state("tailscaled.service"),
        "bridge": unit_state("tomverse-bridge.service"),
    },
    "linger": command("loginctl", "show-user", getpass.getuser(), "-p", "Linger"),
    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest()
    if binary.is_file()
    else None,
    "health": health,
    "panes": panes(),
    "serve": command("tailscale", "serve", "status"),
}
print(json.dumps(snapshot))
