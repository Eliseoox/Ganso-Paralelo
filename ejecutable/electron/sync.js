// Copia todos los archivos de web/ hacia electron/app/
// Se ejecuta automáticamente antes de iniciar o compilar la app.
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', '..', 'web');
const dst = path.resolve(__dirname, 'app');

if (fs.existsSync(dst)) {
  fs.rmSync(dst, { recursive: true, force: true });
}

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const from = path.join(s, entry.name);
    const to   = path.join(d, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

copyDir(src, dst);
console.log('✓ web/ → electron/app/ sincronizado correctamente.');
