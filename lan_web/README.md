# Optional Fabric LAN web preview

This is a source-build preview for a Windows Fabric installation with an existing NVIDIA Runtime and v5turbo assets. It does not change the installer, desktop build, or desktop API. The browser build is separate from `app/frontend` and is intended for interactive use by the machine owner or a trusted private subnet.

## Build and run

```powershell
cd app
npm ci
npm run build:lan
cd ..

py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r lan_web/requirements.txt
.\.venv\Scripts\python.exe -m lan_web.server --root 'C:\path\to\installed\GPT-SoVITS-Fabric'
```

Open `http://127.0.0.1:8790`. The server Python is separate from Fabric's Runtime; synthesis and training spawn the worker scripts and Python already installed in the selected Fabric product root. You can pass `--frontend` if the LAN assets are stored somewhere other than `app/frontend-lan`.

To allow another device on a **trusted private network**, set `--host` to the Windows machine's specific private IPv4 address and add `--trusted-lan`. Open that same address and port in the browser. The server does not accept wildcard binds or public IPs. **There is no account authentication or transport encryption:** any client that can reach that private address can operate the web UI, including running GPU jobs. Restrict access using the host firewall; do not port-forward it or expose it through a public proxy. Do not use it on public/guest Wi‑Fi. Run workloads from one interface at a time; the desktop and the web preview are not a shared job scheduler.

## Scope

- Browse local roles, import/export Fabric ZIP packages, play references, synthesize with CUDA, and download outputs. The web view reports synthesis progress; it does not play partial streaming audio or cancel an in-progress synthesis.
- Open or upload UTF-8 `.list` annotations. Only the annotation is uploaded, not its audio. Relative paths in host lists resolve from the list's folder. For uploads, use Windows paths to existing media. Put reusable host selections under `User_Data/train_inputs`; role lists are also catalogued. Optionally set `GPT_SOVITS_ROOT` to one additional audio directory you explicitly trust.
- Run one v5turbo training job at a time. The adapter copies the normalized manifest to the run directory. Retry starts a fresh attempt without deleting earlier files; queue history is in memory and clearing history does not clean the disk.
- Browse the public community catalog and download compatible voice packs. Desktop-only functions (including sign-in, publishing, Vulkan, installer updates, and local file pickers) are not part of this preview.
- The preview stores preferences in `User_Data/lan_web_config.json`. The roles, training data, and synthesis outputs use the existing product directories.

## Regression checks

```powershell
.\.venv\Scripts\python.exe -m pip install -r lan_web/requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s lan_web/tests -v
cd app
npm test
npm run build
npm run build:lan
```

The Python tests use temporary product directories and synthetic workers; no GPU training or models are needed. They cover queue transitions, training-manifest normalization, character package round trips, synthesis progress, and the local-origin boundary. On Node versions that require an explicit local-storage file, supply `NODE_OPTIONS=--localstorage-file=<temporary file>` for the frontend tests.
