"""
Genera app-debug.apk actualizado con los archivos de web/.
Pipeline completo: patch → strip META-INF → zipalign → re-sign con debug keystore.
El APK resultante se puede instalar directamente en cualquier Android en modo desarrollador.

Uso:  python patch_apk.py
"""
import zipfile, os, subprocess, shutil, sys

# ── Rutas ─────────────────────────────────────────────────────────────────────
BASE     = os.path.dirname(os.path.abspath(__file__))
APK_DIR  = os.path.join(BASE, "android", "app", "build", "outputs", "apk", "debug")
APK_IN   = os.path.join(APK_DIR, "app-debug.apk")          # APK base (firmado original)
APK_WORK = os.path.join(APK_DIR, "_work_patched.apk")       # temporal: parcheado sin firma
APK_ALIG = os.path.join(APK_DIR, "_work_aligned.apk")       # temporal: zipaligned
APK_OUT  = os.path.join(APK_DIR, "app-debug.apk")           # salida final (firmada)
WEB_DIR  = os.path.join(BASE, "web")

SDK_PATH   = os.path.join(os.environ["LOCALAPPDATA"], "Android", "Sdk")
BUILD_TOOL = None
for bt in sorted(os.listdir(os.path.join(SDK_PATH, "build-tools")), reverse=True):
    candidate = os.path.join(SDK_PATH, "build-tools", bt)
    if os.path.isdir(candidate):
        BUILD_TOOL = candidate
        break

ZIPALIGN   = os.path.join(BUILD_TOOL, "zipalign.exe")
APKSIGNER  = os.path.join(BUILD_TOOL, "apksigner.bat")
KEYSTORE   = os.path.join(os.environ["USERPROFILE"], ".android", "debug.keystore")

STORED_EXT   = {'.so', '.arsc'}
STORED_NAMES = {'resources.arsc'}

# ── Helpers ───────────────────────────────────────────────────────────────────
def web_files_map():
    mapping = {}
    for root, _, files in os.walk(WEB_DIR):
        for fname in files:
            local_path = os.path.join(root, fname)
            rel = os.path.relpath(local_path, WEB_DIR).replace('\\', '/')
            mapping['assets/public/' + rel] = local_path
    return mapping

def is_sig_file(name):
    n = name.upper()
    return n.startswith("META-INF/") and (
        n.endswith(".RSA") or n.endswith(".SF") or
        n.endswith(".MF")  or n.endswith(".DSA") or n.endswith(".EC")
    )

def compression(name):
    ext = os.path.splitext(name)[1].lower()
    if ext in STORED_EXT or os.path.basename(name) in STORED_NAMES:
        return zipfile.ZIP_STORED
    return zipfile.ZIP_DEFLATED

# ── Paso 1: patch + strip META-INF en un solo pasada ─────────────────────────
def patch_and_strip(src, dst, patches):
    written_keys = set()
    patched = replaced = stripped = added = 0

    with zipfile.ZipFile(src, 'r') as zin, \
         zipfile.ZipFile(dst, 'w', allowZip64=True) as zout:

        for item in zin.infolist():
            name = item.filename
            comp = compression(name)

            # Eliminar firmas viejas (quedan inválidas tras modificar el ZIP)
            if is_sig_file(name):
                stripped += 1
                continue

            if name in patches:
                with open(patches[name], 'rb') as f:
                    data = f.read()
                item.compress_size = 0
                item.compress_type = comp
                zout.writestr(item, data)
                print(f"  PATCHED  {name}")
                patched += 1
            else:
                data = zin.read(name)
                item.compress_size = 0
                item.compress_type = comp
                zout.writestr(item, data)
                replaced += 1

            written_keys.add(name)

        # Archivos nuevos en web/ que no estaban en el APK original
        for apk_path, local_path in patches.items():
            if apk_path not in written_keys:
                comp = compression(apk_path)
                with open(local_path, 'rb') as f:
                    data = f.read()
                zout.writestr(zipfile.ZipInfo(apk_path), data)
                print(f"  ADDED    {apk_path}")
                added += 1

    print(f"\n  {patched} archivos web reemplazados, {added} agregados, {stripped} firmas eliminadas")

# ── Paso 2: zipalign ──────────────────────────────────────────────────────────
def zipalign(src, dst):
    if os.path.exists(dst):
        os.remove(dst)
    result = subprocess.run([ZIPALIGN, "-f", "4", src, dst], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"zipalign falló:\n{result.stderr.decode()}")
    print("  zipalign OK")

# ── Paso 3: re-firmar con debug keystore ─────────────────────────────────────
def sign(src, dst):
    if os.path.exists(dst):
        os.remove(dst)
    cmd = [
        APKSIGNER, "sign",
        "--ks",          KEYSTORE,
        "--ks-pass",     "pass:android",
        "--key-pass",    "pass:android",
        "--ks-key-alias","androiddebugkey",
        "--out",         dst,
        src,
    ]
    result = subprocess.run(cmd, capture_output=True, shell=True)
    stderr = result.stderr.decode()
    # Los WARNING de java son inofensivos
    errors = [l for l in stderr.splitlines() if "ERROR" in l.upper() and "WARNING" not in l.upper()]
    if errors:
        raise RuntimeError(f"apksigner falló:\n{chr(10).join(errors)}")
    print("  firma V2/V3 OK")

# ── Paso 4: verificar ─────────────────────────────────────────────────────────
def verify(apk):
    result = subprocess.run(
        [APKSIGNER, "verify", "--verbose", apk],
        capture_output=True, shell=True
    )
    output = result.stdout.decode() + result.stderr.decode()
    ok = "Verifies" in output and result.returncode == 0
    for line in output.splitlines():
        if any(k in line for k in ("Verifies", "v2 scheme", "v3 scheme", "Number of signers", "DOES NOT")):
            print(f"  {line.strip()}")
    return ok

# ── Pipeline principal ────────────────────────────────────────────────────────
if __name__ == '__main__':
    print(f"Build tool: {os.path.basename(BUILD_TOOL)}")
    print(f"Keystore:   {KEYSTORE}")

    patches = web_files_map()
    print(f"\n[1/4] Parcheando {len(patches)} archivos de web/...")
    patch_and_strip(APK_IN, APK_WORK, patches)

    print("\n[2/4] zipalign...")
    zipalign(APK_WORK, APK_ALIG)

    print("\n[3/4] Firmando con debug keystore...")
    sign(APK_ALIG, APK_OUT)

    print("\n[4/4] Verificando firma...")
    ok = verify(APK_OUT)

    # Limpiar temporales
    for f in [APK_WORK, APK_ALIG]:
        try: os.remove(f)
        except: pass

    size = os.path.getsize(APK_OUT) / 1_048_576
    if ok:
        print(f"\nOK  app-debug.apk listo ({size:.1f} MB) - instalable en Android")
        print(f"    {APK_OUT}")
    else:
        print(f"\nERROR  La verificacion fallo. Revisa el APK manualmente.")
        sys.exit(1)
