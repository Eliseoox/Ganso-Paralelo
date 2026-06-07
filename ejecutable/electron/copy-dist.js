// Copia la carpeta distribuible al Escritorio después de electron-packager.
const fs   = require('fs');
const path = require('path');

const srcDir  = path.resolve(__dirname, 'dist', 'Ganso-Paralelo-win32-x64');
const desktop = path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop');
const dstDir  = path.join(desktop, 'Ganso-Paralelo');

if (!fs.existsSync(srcDir)) {
  console.error('Error: dist/Ganso-Paralelo-win32-x64 no encontrado. Corré electron:make primero.');
  process.exit(1);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to   = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

if (fs.existsSync(dstDir)) {
  fs.rmSync(dstDir, { recursive: true, force: true });
}

copyDir(srcDir, dstDir);
console.log(`✓ App copiada al Escritorio: Ganso-Paralelo\\`);
console.log('  Abrí la carpeta Ganso-Paralelo y ejecutá Ganso-Paralelo.exe');
