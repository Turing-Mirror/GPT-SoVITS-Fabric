<div align="center">

<img src="app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](./README.md)　·　[繁體中文](./README_zh-TW.md)　·　[English](./README_en.md)　·　[日本語](./README_ja.md)　·　[한국어](./README_ko.md)　·　Español　·　[Français](./README_fr.md)　·　[Русский](./README_ru.md)
<!-- lang-nav -->

**Aplicación de síntesis de voz y entrenamiento de voces de personajes para Windows**

Basado en [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) y mantenido por [Turing Mirror](https://github.com/Turing-Mirror).

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](./app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[Repositorio de GitHub](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [Descarga de artefactos CNB](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**Redes sociales**　[Bilibili @Turing Mirror](https://space.bilibili.com/3546871148579062)　·　[Douyin @Turing Mirror](https://v.douyin.com/6NxXcrKK9cc) (ID de Douyin `TuringMirror`)　·　[Xiaohongshu @Turing Mirror](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094) (ID de Xiaohongshu `TuringMirror`)　·　[YouTube @Turing Mirror](https://www.youtube.com/@TuringMirror) (identificador de YouTube `@TuringMirror`)　·　Grupo de QQ @Comunidad Turing Mirror (ID de grupo `1077458748`)

<img src="app/src/assets/qq_group.jpg" alt="Código QR del grupo de QQ" width="200">

</div>

---

## Capturas de pantalla

![Pantalla de inicio](docs/screenshots/home.png)

![Síntesis de voz](docs/screenshots/synthesis.png)

## Introducción al proyecto

GPT-SoVITS Fabric es una aplicación de escritorio gratuita y de código abierto para Windows desarrollada por Turing Mirror a partir de GPT-SoVITS. Reúne la síntesis de texto a voz, la gestión de voces de personajes, la edición de anotaciones `.list`, la separación vocal y el entrenamiento de modelos en un cliente independiente. No requiere configurar manualmente un entorno de Python ni abrir una interfaz web en el navegador; tras la instalación, el asistente inicial descarga el entorno de ejecución y los modelos base necesarios.

## Características principales

- **Síntesis de voz**: Admite síntesis de texto individual y por lotes, selección de audios de referencia de 3 a 10 segundos desde las anotaciones `.list` vinculadas al personaje, mezcla con referencias auxiliares, salida en streaming, guardado de ajustes por personaje y exportación en WAV y FLAC.
- **Motores de inferencia**: De forma predeterminada ejecuta la inferencia en CUDA o CPU mediante el entorno Python integrado para personajes `v1`, `v2`, `v2Pro`, `v2ProPlus`, `v3`, `v4`, `v5dev` y `v5turbo`; también permite descargar recursos opcionales de Vulkan para ejecutar síntesis en chino y japonés con `v5turbo` en Windows mediante [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp).
- **Gestión de personajes**: Organiza los pesos de SoVITS y GPT, los audios de referencia, las anotaciones `.list`, la portada y los parámetros recomendados en paquetes de personaje, con importación, exportación por lotes, edición de metadatos, recorte de portada y reemplazo de pesos.
- **Anotaciones y preparación de datos**: Incluye un editor de archivos `.list` que comprueba antes de guardar si faltan audios, hay textos vacíos, entradas duplicadas o códigos de idioma desconocidos; incorpora herramientas de separación vocal, corte de audio y transcripción automática.
- **Entrenamiento de modelos**: Ofrece el flujo completo desde la preparación de datos hasta el ajuste fino de SoVITS y GPT para las versiones `v2`, `v2Pro`, `v2ProPlus`, `v4`, `v5dev` y `v5turbo`, con cola de entrenamiento secuencial y reanudación tras interrupciones.
- **Comunidad y descarga de recursos**: Permite explorar y descargar paquetes de personajes, componentes base del motor, modelos preentrenados por versión y modelos de separación vocal con descargas multiconexión reanudables; al iniciar sesión con una cuenta de Turing Mirror es posible enviar y actualizar publicaciones de personajes.
- **API local y MCP**: Incluye un servicio local independiente y `gpt-sovits-fabric-mcp.exe` para que programas locales o clientes MCP consulten personajes e inicien tareas de síntesis. Consulte [API v1](docs/api-v1.md).

## Inicio rápido

1. Instale GPT-SoVITS Fabric y siga la guía del primer inicio para descargar el entorno de ejecución (elija CUDA para tarjetas NVIDIA o CPU en caso contrario) y los recursos base del motor.
2. Vaya a **Comunidad** para descargar un paquete de personaje público o importe uno local en **Modelos**; si desea entrenar su propia voz, prepare los materiales y realice el ajuste fino en **Entrenar**.
3. Abra **Síntesis**, elija un personaje y un audio de referencia de 3 a 10 segundos, escriba el texto, seleccione el motor de inferencia e inicie la síntesis.
4. Para integrarlo con programas externos o un cliente MCP, consulte [API v1](docs/api-v1.md) para configurar `gpt-sovits-fabric-mcp.exe` o iniciar el servicio en segundo plano con `--headless`.

## Arquitectura técnica y desarrollo

### Arquitectura

GPT-SoVITS Fabric utiliza una interfaz de escritorio **Tauri + Rust + React**, mientras que las tareas de inferencia y entrenamiento se ejecutan en procesos en segundo plano. La inferencia CUDA, el entrenamiento y la separación vocal funcionan mediante workers de Python integrados, y la síntesis Vulkan utiliza un servidor local de `gsv.cpp`. La interfaz de escritorio y la API local comparten el mismo flujo de tareas y registro de salidas:

```text
GPT-SoVITS Fabric.exe (aplicación de escritorio Tauri + Rust + React y API local)
    ├─ CUDA / Entrenamiento / Separación ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Síntesis Vulkan                   ─> gsv_server.exe (gsv.cpp para v5turbo)
```

La interfaz web original de Gradio (`webui.py`) se conserva en el paquete y puede iniciarse desde la página **Más**.

### Requisitos y desarrollo

**Requisitos**: Windows 10/11 · Node.js 20+ · Rust Stable (`x86_64-pc-windows-msvc`) · Herramientas de compilación C++ de Visual Studio y WebView2 · Python 3.12+ (scripts de compilación)

```powershell
# 1. Instalar dependencias del frontend y compilar la interfaz
cd app
npm ci
npm run build

# 2. Preparar la raíz de producto para desarrollo e iniciar la aplicación (en Developer PowerShell de Visual Studio)
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

Para previsualizar únicamente la interfaz web en el navegador, ejecute `npm run dev` en `app/`. Consulte [Desarrollo en Windows v1](docs/development-v1.md) y [Registro de decisiones](docs/DECISIONS.md) para obtener instrucciones detalladas, solución de problemas y detalles de arquitectura.

### Compilación y pruebas

- **Pruebas y compilación del frontend**: `cd app && npm test`, `npm run build`
- **Pruebas unitarias de Rust**: `cd app/src-tauri && cargo test --locked --lib`
- **Empaquetar instalador (NSIS)**: `python scripts/build_setup.py` (o `cd app && npm run tauri:build`)
- **Sincronizar código fuente original**: `python scripts/prepare_engine_payload.py --upstream <repositorio-origen> --runtime <Runtime>`
- **Construir Runtime**: `python scripts/build_runtime.py --variant nvidia` (o `cpu`)
- **Empaquetar modelos base**: `python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **Generar catálogo en línea**: `python scripts/build_catalog.py --sources <repositorio-releases>/catalog/sources.json --out <repositorio-releases>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## Licencia y autorización de uso de voz

- El código fuente de este proyecto está publicado bajo la [Licencia MIT](./app/src-tauri/engine-payload/LICENSE).
- Los pesos de modelos, paquetes de personajes y recursos de terceros se rigen por sus licencias originales.
- Obtenga la autorización del titular de los derechos antes de entrenar o sintetizar la voz de otra persona y cumpla con la legislación local aplicable.

## Agradecimientos

Agradecemos a los siguientes proyectos de código abierto por su aporte técnico a GPT-SoVITS Fabric:

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — Modelos acústicos principales y base original
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Soporte para el motor de inferencia Vulkan
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — Arquitectura de escritorio y base de interfaz
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — Motor de separación vocal y origen de modelos
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — Procesamiento y segmentación de audio
