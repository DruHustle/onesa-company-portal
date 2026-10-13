#!/usr/bin/env python3
"""Validate the root-owned Oracle SSH source list before changing firewall rules."""

import argparse
import ipaddress
import os
import stat


def normalize(values):
    sources = []
    for value in values:
        network = ipaddress.ip_network(value, strict=True)
        if network.version != 4 or network.prefixlen != 32 or not network.network_address.is_global:
            raise ValueError("Administrative sources must be public IPv4 /32 addresses")
        source = str(network)
        if source not in sources:
            sources.append(source)
    if not sources:
        raise ValueError("At least one approved SSH source is required")
    return sources


def read_sources(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        metadata = os.fstat(stream.fileno())
        if metadata.st_uid != 0 or not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ValueError("SSH source file must be a root-owned regular file with mode 0600")
        return normalize(stream.read().splitlines())


def require_session(sources, connection):
    session = connection.split()
    if len(session) != 4 or session[3] != "22" or str(ipaddress.ip_address(session[0])) + "/32" not in sources:
        raise ValueError("Current SSH source must be in the approved administrative allowlist")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="*")
    parser.add_argument("--file", help="Existing root-owned mode-600 allowlist to preserve")
    parser.add_argument("--require-ssh-session", action="store_true")
    arguments = parser.parse_args()
    sources = normalize((read_sources(arguments.file) if arguments.file else []) + arguments.sources)
    if arguments.require_ssh_session:
        require_session(sources, os.environ.get("SSH_CONNECTION", ""))
    print("\n".join(sources))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
