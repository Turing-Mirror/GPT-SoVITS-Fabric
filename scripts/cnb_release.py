# -*- coding: utf-8 -*-
"""Publish signed installers to Cloudflare R2 and commit the local GSV catalog.

The website reads the sibling GPT-SoVITS-Fabric-Releases checkout, never CNB.
Release notes come from docs/releases/<version>.md. Without --publish, prepare
a temporary copy only. --publish uploads and verifies both installer names,
removes older versioned installers, and commits locally without pushing.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_storage import R2Publisher, installer_url  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = "Turing-Mirror/GPT-SoVITS-Fabric"
CATALOG = ROOT.parent / "GPT-SoVITS-Fabric-Releases"
FIXED_NAME = "GPT-SoVITS-Fabric-Setup.exe"


def setup_name(version: str) -> str:
    return f"GPT-SoVITS-Fabric-Setup-{version}.exe"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")



def command_env(args):
    """Keep Git credentials separate from artifact credentials."""
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
    url = installer_url("gpt-sovits-fabric", signed["name"])
    if app["version"] == version:
        if app["sha256"] != signed["sha256"] or app["size_bytes"] != signed["size_bytes"]:
            raise ValueError("The existing local release differs from the signed Setup.")
    if version_key(app["version"]) > version_key(version):
        raise ValueError(f"The local catalog is already at {app['version']}.")
    body = "\n".join(notes)
    app.update(sha256=signed["sha256"], size_bytes=signed["size_bytes"], version=version,
               name=signed["name"], ota_name=signed["name"], url=url, notes=body)
    app.pop("release_tag", None)
    app.pop("urls", None)
    write_json(sources_path, sources)

    setup_dir = repo / "assets" / "setup"
    setup_dir.mkdir(parents=True, exist_ok=True)
    for old in setup_dir.glob("GPT-SoVITS-Fabric-Setup-*.exe.sha256"):
        old.unlink()
    for name in (signed["name"], FIXED_NAME):
        (setup_dir / (name + ".sha256")).write_text(f"{signed['sha256']}  {name}\n", encoding="ascii")

    changelog_path = repo / "changelog.json"
    changelog = read_json(changelog_path)
    date = signed["pub_date"][:10].replace("-", "")[2:]
    changelog["entries"] = [entry for entry in changelog["entries"] if entry["version"] != version]
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
    return ["catalog/sources.json", "catalog/online_catalog.snippet.json", "assets/setup",
            "changelog.json", "updater.json", "index.json"]


def mirror_setup(directory: Path, version: str, signed: dict) -> None:
    R2Publisher("gpt-sovits-fabric", "GPT-SoVITS-Fabric-Setup-", FIXED_NAME).publish(
        directory / signed["name"], version, signed["sha256"], signed["size_bytes"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--publish", action="store_true", help="Publish installers to R2 and commit the local catalog without pushing")
    parser.add_argument("--version", default=read_json(ROOT / "app/package.json")["version"])
    parser.add_argument("--catalog", type=Path, default=CATALOG, help="Local release checkout")
    args = parser.parse_args()
    notes = release_notes(args.version)
    # Antivirus may still hold the downloaded Setup when the folder is removed.
    with tempfile.TemporaryDirectory(prefix="gsv-release-", ignore_cleanup_errors=True) as temp:
        scratch = Path(temp)
        signed = verify_release(args.version, scratch)
        repo = args.catalog.resolve()
        if not (repo / ".git").exists():
            raise ValueError("The local release checkout is missing: " + str(repo))
        if run("git", "status", "--porcelain", cwd=repo, capture=True):
            raise ValueError("Commit local catalog changes before publishing.")
        if not args.publish:
            target = scratch / "catalog"
            shutil.copytree(repo, target, ignore=shutil.ignore_patterns(".git"))
            repo = target
        files = prepare_catalog(repo, args.version, signed, notes)
        if not args.publish:
            print("Checked the signed release and prepared a temporary copy of the local GSV catalog.")
            return
        mirror_setup(scratch, args.version, signed)
        run("git", "add", "-A", "--", *files, cwd=repo)
        if run("git", "diff", "--cached", "--name-only", cwd=repo, capture=True):
            run("git", "commit", "-m", f"Release {args.version}", cwd=repo)
        print(f"Cloudflare provides GPT-SoVITS Fabric {args.version}; the catalog is committed locally.")


if __name__ == "__main__":
    main()
