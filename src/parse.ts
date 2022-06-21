import { PackageId, PackageName } from '.';

export const getPackageName = (pkgId: PackageId): PackageName => {
  const idx = pkgId.indexOf(`@`, 1);
  return (idx < 0 ? pkgId : pkgId.substring(0, idx)) as PackageName;
};

export const increaseIndex = (pkgId: PackageId): PackageId => {
  const idParts = pkgId.split('%');
  let idNo = 0;
  if (idParts.length > 1) {
    idNo = parseInt(idParts[1]) + 1;
  }

  return (pkgId + '%' + idNo) as PackageId;
};

export const stripIndex = (pkgId: PackageId): PackageId => pkgId.split('%')[0] as PackageId;
