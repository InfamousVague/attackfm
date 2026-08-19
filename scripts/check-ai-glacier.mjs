import { readFileSync } from 'node:fs';

const aiSurfaces = [
  'src/app/booth/BoothPage.tsx',
  'src/app/booth/DjLauncher.tsx',
  'src/app/booth/DjPage.tsx',
  'src/app/booth/DjTraitSheet.tsx',
];

const rawControls = /<(button|input|textarea|select)\b|role=["']progressbar["']/g;
const failures = [];

for (const file of aiSurfaces) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes("from '@glacier/react'")) {
    failures.push(`${file}: does not import GlacierUI`);
  }
  for (const match of source.matchAll(rawControls)) {
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(`${file}:${line}: raw ${match[0]} control; use @glacier/react`);
  }
}

if (failures.length > 0) {
  console.error(`AI surfaces must use GlacierUI primitives:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log(`GlacierUI check passed for ${aiSurfaces.length} AI surfaces.`);
