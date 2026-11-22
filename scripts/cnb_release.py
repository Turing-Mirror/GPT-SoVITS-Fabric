# -*- coding: utf-8 -*-
"""Publish a signed GPT-SoVITS Fabric release to the CNB catalog.

Run it after the GitHub release is public. The website syncs from CNB afterwards.

1. Download the Setup, signature and checksum from the GitHub release and verify them.
2. Upload the Setup to the CNB `GSV-setup` release twice: with the version in the name
   (updater) and with the fixed name (download page).
3. Update `catalog/sources.json`, the checksum files, `changelog.json` and `updater.json`,
   compile `index.json`, then commit and push the CNB catalog.

Release notes come from `docs/releases/<version>.md`, one line per change.

    python scripts/cnb_release.py              # check and prepare in a temporary clone
    python scripts/cnb_release.py --publish    # upload and push
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from publish_asset import ensure_release, upload  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "Turing-Mirror/GPT-SoVITS-Fabric"
CNB = "Turing-Mirror/GPT-SoVITS-Fabric-Releases"
ORIGIN = f"https://cnb.cool/{CNB}"
TAG = "GSV-setup"
ASSETS = f"{ORIGIN}/-/releases/download/{TAG}/"
FIXED_NAME = "GPT-SoVITS-Fabric-Setup.exe"


def setup_name(version: str) -> str:
    return f"GPT-SoVITS-Fabric-Setup-{version}.exe"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")



def command_env(args):
    """CNB_TOKEN only carries release upload rights; git keeps its own sign-in to push."""
    env = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1", "PYTHONUTF8": "1"}
    if str(args[0]) == "git":
        env.pop("CNB_TOKEN", None)
    return env

def run(*args, cwd=None, capture=False):
    result = subprocess.run([str(a) for a in args], cwd=cwd, check=True, text=True, encoding="utf-8",
                            stdout=subprocess.PIPE if capture else None,
                            env=command_env(args))
    return result.stdout.strip() if capture else None


def version_key(value: str):
    return tuple(map(int, value.split(".")))


def remote_sha256(url: str):
    try:
        with urlopen(Request(url, headers={"User-Agent": "GPT-SoVITS-Fabric"}), timeout=120) as response:
            return hashlib.file_digest(response, "sha256").hexdigest()
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def release_notes(version: str) -> list[str]:
    path = ROOT / "docs" / "releases" / f"{version}.md"
    lines = [re.sub(r"^[-*]\s+", "", line.strip()) for line in path.read_text(encoding="utf-8").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        raise ValueError(f"Write the release notes in {path}.")
    return lines


def verify_release(version: str, directory: Path) -> dict:
    tag = "v" + version
    release = json.loads(run("gh", "release", "view", tag, "--repo", PRODUCT, "--json",
                             "tagName,isDraft,isPrerelease,publishedAt", capture=True))
    if release["tagName"] != tag or release["isDraft"] or release["isPrerelease"] or not release["publishedAt"]:
        raise ValueError("Publish the stable GitHub release first.")
    name = setup_name(version)
    run("gh", "release", "download", tag, "--repo", PRODUCT, "--dir", directory, "--clobber",
        "--pattern", name, "--pattern", name + ".sig", "--pattern", name + ".sha256")
    installer = directory / name
    run("node", ROOT / "scripts/verify_setup_signature.mjs", installer, ROOT / "app/src-tauri/tauri.conf.json")
    sha = hashlib.sha256(installer.read_bytes()).hexdigest()
    return {
        "name": name,
        "sha256": sha,
        "size_bytes": installer.stat().st_size,
        "signature": (directory / (name + ".sig")).read_text(encoding="utf-8").strip(),
        "pub_date": release["publishedAt"],
    }


def prepare_catalog(repo: Path, version: str, signed: dict, notes: list[str]) -> list[str]:
    sources_path = repo / "catalog" / "sources.json"
    sources = read_json(sources_path)
    app = sources["app"]
    url = ASSETS + signed["name"]
    if app["version"] == version:
        if app["sha256"] != signed["sha256"]:
            raise ValueError("The existing CNB release differs from the signed Setup.")
        return []
    if version_key(app["version"]) >= version_key(version):
        raise ValueError(f"The CNB catalog is already at {app['version']}.")
    body = "\n".join(notes)
    app.update(sha256=signed["sha256"], size_bytes=signed["size_bytes"], version=version, notes=body)
    write_json(sources_path, sources)

    setup_dir = repo / "assets" / "setup"
    for old in setup_dir.glob("GPT-SoVITS-Fabric-Setup-*.exe.sha256"):
        old.unlink()
    for name in (signed["name"], FIXED_NAME):
        (setup_dir / (name + ".sha256")).write_text(f"{signed['sha256']}  {name}\n", encoding="ascii")

    changelog_path = repo / "changelog.json"
    changelog = read_json(changelog_path)
    date = signed["pub_date"][:10].replace("-", "")[2:]
    changelog["entries"].insert(0, {"version": version, "date": date, "title": version, "body": body, "highlights": notes})
    write_json(changelog_path, changelog)

    write_json(repo / "updater.json", {
        "version": version,
        "notes": body,
        "pub_date": signed["pub_date"],
        "platforms": {"windows-x86_64": {"url": url, "signature": signed["signature"]}},
    })
    run(sys.executable, ROOT / "scripts/build_catalog.py", "--sources", sources_path, "--out", repo / "index.json")
    gui = read_json(repo / "index.json")["app"]
    if (gui["version"], gui["sha256"], gui["size_bytes"]) != (version, signed["sha256"], signed["size_bytes"]):
        raise ValueError("The compiled index.json does not match the signed Setup.")
    return ["catalog/sources.json", "assets/setup", "changelog.json", "updater.json", "index.json"]


def mirror_setup(directory: Path, signed: dict) -> None:
    release_id = None
    for name in (signed["name"], FIXED_NAME):
        url = ASSETS + name
        if remote_sha256(url) == signed["sha256"]:
            continue
        release_id = release_id or ensure_release(CNB, TAG, "")
        path = directory / name
        if name == FIXED_NAME:
            shutil.copyfile(directory / signed["name"], path)
        uploaded = upload(CNB, release_id, path)
        if uploaded["sha256"] != signed["sha256"] or remote_sha256(url) != signed["sha256"]:
            raise ValueError("The CNB download does not match the signed Setup: " + name)


def load_cnb_token() -> None:
    if os.environ.get("CNB_TOKEN"):
        return
    token_file = Path.home() / ".cnb" / "agent-token"
    if not token_file.is_file():
        return
    line = token_file.read_text(encoding="utf-8-sig").strip()
    match = re.fullmatch(r"""(?:export\s+)?CNB_TOKEN\s*=\s*(['"]?)([^'"\s]+)\1""", line)
    if match:
        os.environ["CNB_TOKEN"] = match.group(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--publish", action="store_true", help="Upload the Setup and push the CNB catalog")
    parser.add_argument("--version", default=read_json(ROOT / "app/package.json")["version"])
    args = parser.parse_args()
    notes = release_notes(args.version)
    # Antivirus may still hold the downloaded Setup when the folder is removed.
    with tempfile.TemporaryDirectory(prefix="gsv-release-", ignore_cleanup_errors=True) as temp:
        scratch = Path(temp)
        signed = verify_release(args.version, scratch)
        repo = scratch / "catalog"
        if args.publish:
            load_cnb_token()
        git = ("git", "-c", "credential.helper=", "-c", "credential.helper=!cnb git-credential")
        run(*git, "clone", "--depth", "1", "--branch", "main", ORIGIN, repo)
        files = prepare_catalog(repo, args.version, signed, notes)
        if not args.publish:
            print("Checked the signed release and prepared the CNB catalog locally.")
            return
        mirror_setup(scratch, signed)
        if files:
            run(*git, "add", "-A", "--", *files, cwd=repo)
            run(*git, "commit", "-m", f"Release {args.version}", cwd=repo)
            run(*git, "push", "origin", "HEAD:main", cwd=repo)
        print(f"CNB provides GPT-SoVITS Fabric {args.version}.")


if __name__ == "__main__":
    main()
