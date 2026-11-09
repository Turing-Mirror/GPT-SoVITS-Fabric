"""Build the optional Windows gsv.cpp engine and shared-model Release assets."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

ENGINE_LIBRARIES = ("ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "ggml-vulkan.dll")
SHARED_FILES = ("bert-f16.gguf", "hubert-f16.gguf", "vocoder-f32.gguf", "resampy_kaiser_best.bin")
TOKENIZER_FILES = ("config.json", "vocab.txt")
DEPENDENCIES = ("gguf", "onnxruntime")


def sha256(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def add_tree(archive: ZipFile, directory: Path, prefix: str) -> None:
    if not directory.is_dir():
        raise FileNotFoundError(directory)
    for file in sorted(directory.rglob("*")):
        rel = file.relative_to(directory)
        if file.is_file() and file.suffix != ".pyc" and "__pycache__" not in rel.parts:
            archive.write(file, f"{prefix}/{rel.as_posix()}")


def add_exporters(archive: ZipFile, upstream: Path, version: str) -> None:
    exporters = upstream / "tools/export_gguf"
    for file in sorted(exporters.glob("*.py")):
        target = f"tools/export_gguf/{file.name}"
        if file.name != "export.py" or version != "0.1.3":
            archive.write(file, target)
            continue
        text = file.read_text(encoding="utf-8")
        # The v0.1.3 server reads AR embeddings directly as F32 on the host.
        incompatible = "attn=f16,ffn=f16,predict=f16,emb=f16"
        if text.count(incompatible) != 1:
            raise ValueError("Expected the v0.1.3 F16 exporter preset")
        archive.writestr(target, text.replace(incompatible, "attn=f16,ffn=f16,predict=f16"))


def write_server(archive: ZipFile, source: ZipFile, args: argparse.Namespace, directory: Path) -> None:
    name = "gsv_server.exe"
    if args.upstream_version != "0.1.3":
        with source.open(name) as src, archive.open(f"bin/{name}", "w") as dest:
            shutil.copyfileobj(src, dest)
        return

    mt = args.mt or shutil.which("mt.exe")
    if not mt:
        raise FileNotFoundError("Pass the Windows SDK manifest tool with --mt")
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".exe", delete=False) as temp:
        executable = Path(temp.name)
        with source.open(name) as src:
            shutil.copyfileobj(src, temp)
    manifest = executable.with_suffix(".manifest")
    try:
        # v0.1.3 opens some GGUF files through narrow Windows file APIs.
        manifest.write_text(
            """<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <assemblyIdentity type="win32" name="KakaruHayate.gsv.cpp" version="0.1.3.0"/>
  <asmv3:application>
    <asmv3:windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>
""",
            encoding="utf-8",
        )
        subprocess.run([mt, "-nologo", "-manifest", str(manifest), f"-outputresource:{executable};#1"], check=True)
        with executable.open("rb") as src, archive.open(f"bin/{name}", "w") as dest:
            shutil.copyfileobj(src, dest)
    finally:
        executable.unlink(missing_ok=True)
        manifest.unlink(missing_ok=True)


def build_engine(args: argparse.Namespace, output: Path) -> None:
    if sha256(args.binary).lower() != args.binary_sha256.lower():
        raise ValueError("gsv.cpp Windows binary SHA-256 differs from the upstream release")
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=3) as archive:
        with ZipFile(args.binary) as source:
            write_server(archive, source, args, output.parent)
            for name in ENGINE_LIBRARIES:
                with source.open(name) as src, archive.open(f"bin/{name}", "w") as dest:
                    shutil.copyfileobj(src, dest)
        archive.writestr("VERSION", args.upstream_version + "\n")
        archive.write(args.upstream / "LICENSE", "LICENSE")
        archive.write(args.upstream / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")
        add_tree(archive, args.upstream / "licenses", "licenses")
        for notice in args.license:
            archive.write(notice, f"licenses/{notice.name}")
        archive.write(args.upstream / "tools/text_sidecar.py", "tools/text_sidecar.py")
        add_tree(archive, args.upstream / "frontend", "frontend")
        add_exporters(archive, args.upstream, args.upstream_version)
        for name in DEPENDENCIES:
            roots = [root for root in args.deps if (root / name).is_dir()]
            if len(roots) != 1:
                raise ValueError(f"Expected one dependency directory for {name}")
            root = roots[0]
            add_tree(archive, root / name, f"deps/{name}")
            metadata = list(root.glob(f"{name}-*.dist-info"))
            if len(metadata) != 1:
                raise ValueError(f"Expected one wheel metadata directory for {name}")
            add_tree(archive, metadata[0], f"deps/{metadata[0].name}")


def build_shared(args: argparse.Namespace, output: Path) -> None:
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=1) as archive:
        for name in SHARED_FILES:
            archive.write(args.shared / name, name)
        for name in TOKENIZER_FILES:
            archive.write(args.tokenizer / name, f"bert_tokenizer/{name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path, help="Pinned gsv.cpp source checkout")
    parser.add_argument("--upstream-version", required=True)
    parser.add_argument("--binary", required=True, type=Path, help="Official Windows Vulkan ZIP")
    parser.add_argument("--binary-sha256", required=True)
    parser.add_argument("--mt", help="Windows SDK manifest tool for the v0.1.3 engine")
    parser.add_argument("--deps", required=True, action="append", type=Path, help="Python wheel install directory")
    parser.add_argument("--shared", required=True, type=Path, help="Shared GGUF and resampler files")
    parser.add_argument("--tokenizer", required=True, type=Path)
    parser.add_argument("--license", action="append", type=Path, default=[], help="Additional dependency license notice")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--version", default="v1", help="Fabric resource archive version")
    parser.add_argument("--part", choices=("engine", "shared"), help="Build one part and keep the other manifest entry")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if args.part and manifest_path.is_file() else {}
    for part, build in (("engine", build_engine), ("shared", build_shared)):
        if args.part and part != args.part:
            continue
        output = args.out / f"gsv-cpp-{part}-{args.version}.zip"
        temp = output.with_suffix(".zip.part")
        build(args, temp)
        temp.replace(output)
        manifest[part] = {"name": output.name, "size_bytes": output.stat().st_size, "sha256": sha256(output)}
        print(f"{output.name}: {manifest[part]['size_bytes']:,} bytes", flush=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
