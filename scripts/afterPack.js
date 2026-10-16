'use strict';
// Explicit exe-identity step (Task 2 risk mitigation).
// This machine cannot create symlinks (no Developer Mode / elevation), so the
// stock winCodeSign toolchain cannot even be extracted — and with
// `signAndEditExecutable: false` electron-builder skips exe editing entirely,
// which would ship Electron's icon + VersionInfo again. Instead this
// afterPack hook runs the standalone rcedit binary (no symlinks involved)
// against the packed exe to embed the brand icon + Flinkynotes VersionInfo.
// Runs after files land in appOutDir, before the portable/NSIS targets are
// built from it, so the identity flows into every artifact.
const path = require('path');
const { rcedit } = require('rcedit');

exports.default = async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const projectDir = context.packager.projectDir;
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(projectDir, 'assets', 'Logo', 'favicon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: 'Flinkynotes',
      FileDescription: 'Flinkynotes',
      ProductName: 'Flinkynotes',
      InternalName: 'Flinkynotes',
      OriginalFilename: `${productFilename}.exe`,
    },
  });
  console.log(`afterPack: branded ${exe}`);
};
