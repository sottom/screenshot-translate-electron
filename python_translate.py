#!/usr/bin/env python3
import sys
from pathlib import Path


def emit_progress(percent: int, message: str) -> None:
    safe_percent = max(0, min(100, int(percent)))
    print(f"PROGRESS:{safe_percent}:{message}", flush=True)


def get_translation_pair():
    from argostranslate import translate

    installed_languages = translate.get_installed_languages()
    from_lang = next((lang for lang in installed_languages if lang.code == "ja"), None)
    to_lang = next((lang for lang in installed_languages if lang.code == "en"), None)
    return from_lang, to_lang


def check_model_installed() -> bool:
    try:
        from argostranslate import package
        installed_packages = package.get_installed_packages()
        pkg = next(
            (
                p
                for p in installed_packages
                if getattr(p, "from_code", None) == "ja" and getattr(p, "to_code", None) == "en"
            ),
            None,
        )
        return pkg is not None
    except Exception:
        return False


def get_bundled_model_paths():
    models_dir = Path(__file__).resolve().parent / "models"
    if not models_dir.exists():
        return []
    return sorted(models_dir.glob("*.argosmodel"))


def install_bundled_model_if_present() -> bool:
    try:
        from argostranslate import package
    except Exception:
        return False

    model_paths = get_bundled_model_paths()
    if not model_paths:
        return False

    for model_path in model_paths:
        try:
            emit_progress(30, f"Installing bundled model: {model_path.name}")
            package.install_from_path(str(model_path))
            if check_model_installed():
                emit_progress(100, "Bundled Japanese-English model installed")
                return True
        except Exception:
            continue
    return False


def install_model_if_needed() -> int:
    try:
        from argostranslate import package
    except Exception as exc:
        print(f"ARGOS_ERROR: import failed: {exc}", file=sys.stderr)
        return 2

    emit_progress(5, "Checking local translation model")
    if check_model_installed():
        emit_progress(100, "Japanese-English model is already installed")
        return 0

    emit_progress(15, "Checking bundled translation model")
    if install_bundled_model_if_present():
        return 0

    try:
        emit_progress(20, "Fetching available translation packages")
        package.update_package_index()

        available = package.get_available_packages()
        ja_en_pkg = next(
            (
                pkg
                for pkg in available
                if getattr(pkg, "from_code", None) == "ja" and getattr(pkg, "to_code", None) == "en"
            ),
            None,
        )
        if ja_en_pkg is None:
            print("ARGOS_ERROR: could not find ja->en package in index", file=sys.stderr)
            return 3

        emit_progress(40, "Downloading Japanese-English model (one-time setup)")
        download_path = ja_en_pkg.download()

        emit_progress(80, "Installing model")
        package.install_from_path(download_path)

        if not check_model_installed():
            print("ARGOS_ERROR: install completed but model not available", file=sys.stderr)
            return 4

        emit_progress(100, "One-time setup complete")
        return 0
    except Exception as exc:
        print(f"ARGOS_ERROR: install failed: {exc}", file=sys.stderr)
        return 5


def run_translation(text: str) -> int:
    try:
        from argostranslate import translate
        if not check_model_installed():
            print("ARGOS_ERROR: ja->en package not installed", file=sys.stderr)
            return 3
        translated = translate.translate(text, "ja", "en")
        print((translated or "").strip())
        return 0
    except Exception as exc:
        print(f"ARGOS_ERROR: translation failed: {exc}", file=sys.stderr)
        return 4


def main() -> None:
    argv = sys.argv[1:]

    if argv and argv[0] == "--check-model":
        try:
            print("ready" if check_model_installed() else "missing")
            return
        except Exception as exc:
            print(f"ARGOS_ERROR: check failed: {exc}", file=sys.stderr)
            sys.exit(2)

    if argv and argv[0] == "--install-model":
        code = install_model_if_needed()
        if code != 0:
            sys.exit(code)
        return

    text = " ".join(argv).strip()
    if not text:
        print("")
        return

    sys.exit(run_translation(text))


if __name__ == "__main__":
    main()
