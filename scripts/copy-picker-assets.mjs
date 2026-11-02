import { copyFile, mkdir } from 'node:fs/promises';
const destination = new URL('../apps/desktop/dist/picker/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['picker.html', 'picker.css', 'picker.js'])
  await copyFile(
    new URL('../apps/desktop/src/picker/' + name, import.meta.url),
    new URL(name, destination),
  );
