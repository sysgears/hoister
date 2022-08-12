import { PackageId, PackageName } from './hoist';

export const getPackageName = (pkgId: PackageId): PackageName => {
  const idx = pkgId.indexOf(`@`, 1);
  return (idx < 0 ? pkgId : pkgId.substring(0, idx)) as PackageName;
};
