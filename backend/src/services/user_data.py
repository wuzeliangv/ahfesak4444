"""
Cloud-init / EC2Launch user-data builders, shared by EC2 and Lightsail.

The actual script bodies are identical on both services because AWS uses
the same boot-time mechanisms underneath:
  - Linux:   cloud-init runs the bash payload as root on first boot
  - Windows: EC2Launch (v2 on AL/Win 2022+) evaluates <powershell>…</powershell>

For password injection we:
  - Linux: set root password via chpasswd, enable PermitRootLogin and
           PasswordAuthentication, then wipe any drop-in overrides that
           Ubuntu/Debian images ship which would otherwise re-disable
           password auth. Multiple service-name fallbacks because SSH
           service naming varies across distros.
  - Windows: turn off password complexity (so weak personal passwords are
             accepted), then `net user <user> <pass>`. Password is passed
             through base64 to dodge PowerShell quoting hell.
"""

from __future__ import annotations

import base64
import shlex


def build_password_user_data(os_type: str, default_user: str, password: str) -> str:
    """Return a first-boot script that sets a login password.

    `os_type` is "linux" or "windows".
    `default_user` is the local account to set on Windows (e.g.
    "Administrator"); on Linux it is currently unused — we always target
    `root`.
    """
    if os_type == "windows":
        b64 = base64.b64encode(password.encode("utf-8")).decode("ascii")
        return f"""<powershell>
$pass = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("{b64}"))
secedit /export /cfg c:\\secpol.cfg
(Get-Content c:\\secpol.cfg) -replace "PasswordComplexity = 1", "PasswordComplexity = 0" | Set-Content c:\\secpol.cfg
secedit /configure /db c:\\windows\\security\\local.sdb /cfg c:\\secpol.cfg /areas SECURITYPOLICY
Remove-Item c:\\secpol.cfg
net user {default_user} $pass
</powershell>
<persist>false</persist>"""

    quoted = shlex.quote(password)
    return f"""#!/bin/bash
echo "root:"{quoted} | chpasswd
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/g' /etc/ssh/sshd_config
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/g' /etc/ssh/sshd_config
# Cloud images ship drop-in overrides that re-disable password auth — nuke them.
rm -rf /etc/ssh/sshd_config.d/* 2>/dev/null || true
# Restart sshd — service name and init manager vary across distros.
systemctl restart sshd 2>/dev/null \\
  || systemctl restart ssh 2>/dev/null \\
  || service sshd restart 2>/dev/null \\
  || service ssh restart 2>/dev/null \\
  || true
"""
