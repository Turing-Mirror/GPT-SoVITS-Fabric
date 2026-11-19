<div align="center">

<img src="../../app/src/assets/brand/gsvf-main-logo.svg" alt="GPT-SoVITS Fabric" width="128">

# GPT-SoVITS Fabric

<!-- lang-nav -->
[简体中文](../../README.md)　·　[繁體中文](./README_zh-TW.md)　·　[English](./README_en.md)　·　[日本語](./README_ja.md)　·　[한국어](./README_ko.md)　·　[Español](./README_es.md)　·　[Français](./README_fr.md)　·　Русский
<!-- lang-nav -->

**Приложение для синтеза речи и обучения голосов персонажей под Windows**

Основано на [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) и поддерживается [Turing Mirror](https://github.com/Turing-Mirror).

[![Licence](https://img.shields.io/badge/LICENSE-MIT-green.svg?style=flat-square)](../../app/src-tauri/engine-payload/LICENSE)
[![Based on GPT-SoVITS](https://img.shields.io/badge/based%20on-GPT--SoVITS-1289F0?style=flat-square)](https://github.com/RVC-Boss/GPT-SoVITS)

[Репозиторий GitHub](https://github.com/Turing-Mirror/GPT-SoVITS-Fabric) · [Загрузка артефактов CNB](https://cnb.cool/Turing-Mirror/GPT-SoVITS-Fabric-Releases)

**Социальные сети**　[Bilibili @Turing Mirror](https://space.bilibili.com/3546871148579062)　·　[Douyin @Turing Mirror](https://v.douyin.com/6NxXcrKK9cc) (Douyin ID `TuringMirror`)　·　[Xiaohongshu @Turing Mirror](https://www.xiaohongshu.com/user/profile/65f56bf1000000000b00e094) (Xiaohongshu ID `TuringMirror`)　·　[YouTube @Turing Mirror](https://www.youtube.com/@TuringMirror) (аккаунт YouTube `@TuringMirror`)　·　Группа QQ @Сообщество Turing Mirror (номер группы `1077458748`)

<img src="../../app/src/assets/qq_group.jpg" alt="QR-код группы QQ" width="200">

</div>

---

## Снимки экрана

![Главный экран](../screenshots/home.png)

![Синтез речи](../screenshots/synthesis.png)

## О проекте

GPT-SoVITS Fabric — бесплатное настольное приложение с открытым исходным кодом для Windows, разработанное Turing Mirror на базе GPT-SoVITS. Оно объединяет синтез речи по тексту, управление голосами персонажей, редактирование разметки `.list`, отделение вокала и обучение моделей в едином автономном клиенте. Отдельная настройка Python или запуск веб-интерфейса в браузере не требуются: после установки мастер первого запуска загрузит нужную среду выполнения и базовые модели.

## Основные возможности

- **Синтез речи**: Поддерживает одиночный и пакетный синтез текста, выбор эталонных аудиозаписей длительностью от 3 до 10 секунд из связанной разметки `.list`, смешивание вспомогательных референсов, потоковый вывод, сохранение параметров для каждого персонажа и экспорт в WAV и FLAC.
- **Механизмы вывода**: По умолчанию выполняет инференс на CUDA или CPU через встроенную среду Python для персонажей `v1`, `v2`, `v2Pro`, `v2ProPlus`, `v3`, `v4`, `v5dev` и `v5turbo`. При необходимости можно загрузить ресурсы Vulkan и запускать синтез на китайском и японском языках для `v5turbo` в Windows через [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp).
- **Управление персонажами**: Объединяет веса SoVITS и GPT, эталонные аудиозаписи, разметку `.list`, обложку и рекомендованные параметры в пакеты персонажей; поддерживает импорт, пакетный экспорт, редактирование метаданных, обрезку обложки и замену весов.
- **Разметка и подготовка данных**: Встроенный редактор `.list` перед сохранением проверяет отсутствие аудиофайлов, пустые строки, дубликаты и коды языков; также доступны инструменты разделения вокала, нарезки аудио и автоматической транскрибации.
- **Обучение моделей**: Охватывает подготовку данных и дообучение SoVITS и GPT для версий `v2`, `v2Pro`, `v2ProPlus`, `v4`, `v5dev` и `v5turbo`, включая последовательную очередь обучения и возобновление после прерывания.
- **Сообщество и загрузка ресурсов**: Позволяет просматривать и скачивать пакеты персонажей, базовые компоненты движка, предобученные модели разных версий и модели разделения вокала с многопоточной загрузкой и докачкой; после входа в аккаунт Turing Mirror можно отправлять и обновлять публикации персонажей.
- **Локальный API и MCP**: В комплект входят автономная фоновая служба и `gpt-sovits-fabric-mcp.exe`, позволяющие локальным программам и MCP-клиентам запрашивать персонажей и запускать синтез речи. Подробности приведены в [API v1](../api-v1.md).

## Быстрый старт

1. Установите GPT-SoVITS Fabric и следуйте подсказкам первого запуска для загрузки среды выполнения (выберите CUDA для видеокарт NVIDIA или CPU в остальных случаях) и базовых ресурсов движка.
2. Откройте «Сообщество» для загрузки публичного пакета персонажа или импортируйте локальный пакет в разделе «Модели»; чтобы создать собственный голос, подготовьте материалы и выполните обучение в разделе «Обучение».
3. Откройте «Синтез», выберите персонажа и эталонную аудиозапись длительностью 3–10 секунд, введите текст, выберите механизм вывода и запустите синтез.
4. Для интеграции с внешними программами или MCP-клиентами обратитесь к [API v1](../api-v1.md) для настройки `gpt-sovits-fabric-mcp.exe` или запуска службы с флагом `--headless`.

## Техническая архитектура и разработка

### Архитектура

GPT-SoVITS Fabric использует настольную оболочку **Tauri + Rust + React**, а задачи инференса и обучения выполняются в фоновых процессах. Вывод на CUDA, обучение и разделение вокала выполняются через встроенные Python-воркеры, а синтез через Vulkan — через локальный сервер `gsv.cpp`. Настольный интерфейс и локальный API используют общий поток задач и журнал результатов:

```text
GPT-SoVITS Fabric.exe (настольное приложение Tauri + Rust + React и локальный API)
    ├─ CUDA / Обучение / Разделение ─> Runtime (Python 3.12 + PyTorch 2.7.1) + tools/*_worker.py
    └─ Синтез Vulkan                ─> gsv_server.exe (gsv.cpp для v5turbo)
```

Оригинальный Gradio WebUI (`webui.py`) сохранён в пакете и при необходимости запускается со страницы «Другое».

### Требования и разработка

**Требования**: Windows 10/11 · Node.js 20+ · Rust Stable (`x86_64-pc-windows-msvc`) · Инструменты сборки C++ Visual Studio и WebView2 · Python 3.12+ (сборочные скрипты)

```powershell
# 1. Установка зависимостей фронтенда и сборка интерфейса
cd app
npm ci
npm run build

# 2. Сборка каталога продукта для разработки и запуск приложения (в Visual Studio Developer PowerShell)
cd ..
python scripts/dev_root.py --pretrained <pretrained_models> --g2pw <G2PWModel>
$env:TM_VOICE_ROOT = (Resolve-Path data/dev-root).Path
cd app/src-tauri
cargo build --locked --bins -j 1
Copy-Item -Path ../frontend/* -Destination target/debug/frontend -Recurse -Force
./target/debug/gpt-sovits-fabric.exe --product-root $env:TM_VOICE_ROOT
```

Для просмотра только веб-интерфейса в браузере выполните `npm run dev` в каталоге `app/`. Подробные инструкции по сборке, устранению ошибок и принятым решениям описаны в [Разработка для Windows v1](../development-v1.md) и [Журнал решений](../DECISIONS.md).

### Сборка и тестирование

- **Тесты и сборка фронтенда**: `cd app && npm test`, `npm run build`
- **Модульные тесты Rust**: `cd app/src-tauri && cargo test --locked --lib`
- **Сборка установщика (NSIS)**: `python scripts/build_setup.py` (или `cd app && npm run tauri:build`)
- **Синхронизация с исходным проектом**: `python scripts/prepare_engine_payload.py --upstream <репозиторий> --runtime <Runtime>`
- **Сборка Runtime**: `python scripts/build_runtime.py --variant nvidia` (или `cpu`)
- **Сборка базовых моделей**: `python scripts/build_engine_core.py --pretrained <pretrained_models> --g2pw <G2PWModel>`
- **Сборка онлайн-каталога**: `python scripts/build_catalog.py --sources <репозиторий-релизов>/catalog/sources.json --out <репозиторий-релизов>/index.json --bundle app/src-tauri/engine-payload/configs/online_catalog.json`

## Лицензия и разрешение на использование голоса

- Исходный код проекта распространяется под лицензией [MIT License](../../app/src-tauri/engine-payload/LICENSE).
- Веса моделей, пакеты персонажей и сторонние ресурсы регулируются их собственными лицензионными соглашениями.
- Перед использованием чужого голоса для обучения или синтеза речи получите разрешение правообладателя и соблюдайте требования применимого законодательства.

## Благодарности

Благодарим следующие проекты с открытым исходным кодом за техническую основу GPT-SoVITS Fabric:

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — Основные акустические модели и исходная база
- [gsv.cpp](https://github.com/KakaruHayate/gsv.cpp) — Поддержка вывода через Vulkan
- [RVC Fabric](https://github.com/Turing-Mirror/RVC-Fabric) — Архитектура настольного клиента и основа интерфейса
- [PyMSS](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) · [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) — Движок разделения вокала и источник моделей
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) · [audio-slicer](https://github.com/openvpi/audio-slicer) — Обработка и нарезка аудио
